#!/usr/bin/env python3
"""Read a LeRobot dataset from disk and show one episode in the Rerun web viewer.

An episode is exported to an .rrd file on the machine that holds the dataset, and served from
whichever machine runs the viewer, so the two can differ.

Reads the dataset files directly (parquet + mp4), so it needs only rerun-sdk, pyarrow, av and
pillow, not the lerobot package. Supports dataset format v2.x and v3.0.

Commands print JSON on stdout:
  check                    -> {"ok": true, "rerun": "0.22.1"}
  episodes --root DIR      -> {"episodes": [...]}
  serve --root DIR --episode N --web-port P --data-port Q [--host NAME]
                           -> JSON events per line: ready, progress, warning, loaded, error;
                              serves until stdin closes
  export --root DIR --episode N --out FILE.rrd
                           -> JSON events per line: progress, warning, exported, error
  view --rrd FILE.rrd --web-port P --data-port Q
                           -> JSON events per line: ready, error; serves until stdin closes
"""

from __future__ import annotations

import argparse
import bisect
import io
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import quote

INDEX_COLUMNS = {"timestamp", "frame_index", "episode_index", "index", "task_index"}


def emit(event: dict) -> None:
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def jsonable(value):
    """Keep only values the episode list can show."""
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, (list, tuple)) and all(isinstance(v, (str, int, float, bool)) for v in value):
        return list(value)
    return None


class Dataset:
    def __init__(self, root: str) -> None:
        self.root = Path(root).expanduser()
        info_path = self.root / "meta" / "info.json"
        if not info_path.is_file():
            raise FileNotFoundError(f"Not a LeRobot dataset (no meta/info.json): {self.root}")
        self.info = json.loads(info_path.read_text())
        self.version = str(self.info.get("codebase_version", ""))
        self.v3 = self.version.startswith("v3")
        if not (self.v3 or self.version.startswith("v2")):
            raise ValueError(f"Unsupported LeRobot dataset version: {self.version or 'unknown'}")
        self.fps = float(self.info.get("fps") or 30)
        self.features: dict = self.info.get("features", {})

    @property
    def video_keys(self) -> list[str]:
        return [k for k, f in self.features.items() if f.get("dtype") == "video"]

    @property
    def image_keys(self) -> list[str]:
        return [k for k, f in self.features.items() if f.get("dtype") == "image"]

    def _tasks_v2(self) -> dict[int, str]:
        path = self.root / "meta" / "tasks.jsonl"
        tasks: dict[int, str] = {}
        if path.is_file():
            for line in path.read_text().splitlines():
                if line.strip():
                    row = json.loads(line)
                    tasks[int(row["task_index"])] = str(row.get("task", ""))
        return tasks

    def episode_rows(self) -> list[dict]:
        """One dict per episode with every non-stats metadata column."""
        if self.v3:
            import pyarrow.parquet as pq

            rows: list[dict] = []
            for file in sorted((self.root / "meta" / "episodes").glob("chunk-*/file-*.parquet")):
                names = [n for n in pq.read_schema(file).names if not n.startswith("stats/")]
                rows.extend(pq.read_table(file, columns=names).to_pylist())
            rows.sort(key=lambda r: r["episode_index"])
            return rows
        path = self.root / "meta" / "episodes.jsonl"
        rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        rows.sort(key=lambda r: r["episode_index"])
        return rows

    def episode_row(self, episode: int) -> dict:
        for row in self.episode_rows():
            if int(row["episode_index"]) == episode:
                return row
        raise ValueError(f"Episode {episode} is not in this dataset")

    def list_episodes(self) -> list[dict]:
        out = []
        for row in self.episode_rows():
            extra = {}
            for key, value in row.items():
                if key in ("episode_index", "tasks", "length") or "/" in key or key.startswith("dataset_"):
                    continue
                value = jsonable(value)
                if value is not None and value != "" and value != []:
                    extra[key] = value
            out.append(
                {
                    "index": int(row["episode_index"]),
                    "length": int(row.get("length") or 0),
                    "tasks": [str(t) for t in (row.get("tasks") or [])],
                    "extra": extra,
                }
            )
        return out

    def frames(self, row: dict):
        """The episode's rows of the data table, ordered by frame_index."""
        import pyarrow.compute as pc
        import pyarrow.parquet as pq

        episode = int(row["episode_index"])
        if self.v3:
            path = self.root / self.info["data_path"].format(
                chunk_index=int(row["data/chunk_index"]), file_index=int(row["data/file_index"])
            )
            table = pq.read_table(path, filters=[("episode_index", "=", episode)])
        else:
            chunk = episode // int(self.info.get("chunks_size") or 1000)
            path = self.root / self.info["data_path"].format(episode_chunk=chunk, episode_index=episode)
            table = pq.read_table(path)
        if "frame_index" in table.column_names:
            table = table.take(pc.sort_indices(table, sort_keys=[("frame_index", "ascending")]))
        return table

    def video(self, row: dict, key: str) -> tuple[Path, float, float | None]:
        """Video file of one camera and the episode's [from, to) seconds inside it."""
        episode = int(row["episode_index"])
        if self.v3:
            path = self.root / self.info["video_path"].format(
                video_key=key,
                chunk_index=int(row[f"videos/{key}/chunk_index"]),
                file_index=int(row[f"videos/{key}/file_index"]),
            )
            return path, float(row[f"videos/{key}/from_timestamp"]), float(row[f"videos/{key}/to_timestamp"])
        chunk = episode // int(self.info.get("chunks_size") or 1000)
        path = self.root / self.info["video_path"].format(
            episode_chunk=chunk, episode_index=episode, video_key=key
        )
        return path, 0.0, None


def dim_names(feature: dict, size: int) -> list[str]:
    names = feature.get("names")
    if isinstance(names, dict):  # e.g. {"motors": [...]}
        flat = [n for group in names.values() if isinstance(group, list) for n in group]
        names = flat
    if isinstance(names, list) and len(names) == size and all(isinstance(n, str) for n in names):
        return [n.replace("/", "_") for n in names]
    return [str(i) for i in range(size)]


# The data server keeps the whole episode for viewers that connect late, so allow plenty.
SERVER_MEMORY = "50%"
VIDEO_CODECS = {"av1", "libdav1d", "libaom-av1", "h264"}  # what the Rerun web viewer decodes

# Preview video: small, quick to decode on any computer, and quick to make on any computer.
PREVIEW_WIDTH = 640
SEGMENT_SECONDS = 10
PREVIEW_VERSION = 1  # bump when the preview encoding changes, to skip stale cache entries
# Encoders in order of preference. Hardware encoders are skipped when their driver is missing.
# "bf": no B-frames, so frames decode in order; "g": a keyframe every second for quick seeking.
ENCODERS = [
    ("h264_nvenc", {"preset": "p4", "rc": "vbr", "cq": "30"}),
    ("h264_qsv", {"preset": "veryfast", "global_quality": "30"}),
    ("h264_videotoolbox", {"q:v": "55"}),
    ("libx264", {"preset": "veryfast", "crf": "28"}),
    ("libopenh264", {}),
]
# Plots shown by default; the rest are logged and listed in the blueprint, hidden.
VISIBLE_PLOTS = 4
VISIBLE_PLOT_DIMS = 16
MAX_SCALAR_DIMS = 256


def remux_segment(path: Path, start: float, end: float | None) -> tuple[bytes, float]:
    """Copy the packets of [start, end) into a standalone MP4 without re-encoding.

    The copy starts at the keyframe at or before `start`. Returns the MP4 bytes and the time in
    the source file that became 0 in the copy.
    """
    import av

    with av.open(str(path)) as source:
        stream = source.streams.video[0]
        if stream.codec_context.name not in VIDEO_CODECS:
            raise ValueError(f"codec {stream.codec_context.name} is not supported by the Rerun viewer")
        if start > 0:
            source.seek(int(start / stream.time_base), stream=stream, backward=True)
        buffer = io.BytesIO()
        offset = None
        with av.open(buffer, "w", format="mp4") as target:
            try:
                # opaque: copy the codec parameters without looking up an encoder for them.
                out = target.add_stream_from_template(stream, opaque=True)
            except TypeError:  # PyAV before 14
                out = target.add_stream(template=stream)
            for packet in source.demux(stream):
                if packet.dts is None or packet.pts is None:
                    continue
                if offset is None:
                    if not packet.is_keyframe:
                        continue
                    offset = packet.dts
                # Packets come in decode order, and B-frames near the end reference frames that are
                # shown after it. Keep about a second past the end so those decode; the frame
                # references never point past the episode.
                if end is not None and float(packet.dts * stream.time_base) >= end + 1.0:
                    break
                packet.pts -= offset
                packet.dts -= offset
                packet.stream = out
                target.mux(packet)
        if offset is None:
            raise ValueError("no keyframe found")
        return buffer.getvalue(), float(offset * stream.time_base)


def episode_frames(path: Path, start: float, end: float | None, fps: float, limit: int):
    """Yield the decoded frames of [start, end) in presentation order, at most `limit`."""
    import av

    half = 0.5 / fps
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        if start > 0:
            container.seek(int(max(start - 1.0, 0.0) / stream.time_base), stream=stream, backward=True)
        count = 0
        for frame in container.decode(stream):
            if frame.time is None or frame.time < start - half:
                continue
            if (end is not None and frame.time >= end - half) or count >= limit:
                break
            count += 1
            yield frame


_encoder: tuple[str, dict] | None = None


def preview_encoder(fps: int) -> tuple[str, dict]:
    """The first encoder in ENCODERS that opens and encodes on this computer."""
    global _encoder
    if _encoder is None:
        import av
        import numpy as np

        for name, options in ENCODERS:
            try:
                buffer = io.BytesIO()
                with av.open(buffer, "w", format="mp4") as out:
                    stream = out.add_stream(name, rate=fps, options={**options, "bf": "0", "g": str(fps)})
                    stream.width, stream.height, stream.pix_fmt = 64, 64, "yuv420p"
                    frame = av.VideoFrame.from_ndarray(np.zeros((64, 64, 3), np.uint8), format="rgb24")
                    for packet in stream.encode(frame.reformat(format="yuv420p")):
                        out.mux(packet)
                    for packet in stream.encode():
                        out.mux(packet)
                _encoder = (name, options)
                break
            except Exception:  # driver or library missing; try the next one
                continue
        if _encoder is None:
            raise RuntimeError("No H.264 encoder is available in PyAV on this computer.")
    return _encoder


def encode_segment(frames, count: int, width: int, height: int, fps: int) -> tuple[bytes, int]:
    """Encode up to `count` frames from the iterator into one MP4. Returns its bytes and frame count."""
    from fractions import Fraction

    import av

    name, options = preview_encoder(fps)
    buffer = io.BytesIO()
    encoded = 0
    with av.open(buffer, "w", format="mp4") as out:
        stream = out.add_stream(name, rate=fps, options={**options, "bf": "0", "g": str(fps)})
        stream.width, stream.height, stream.pix_fmt = width, height, "yuv420p"
        for frame in frames:
            small = frame.reformat(width=width, height=height, format="yuv420p")
            small.pts, small.time_base = encoded, Fraction(1, fps)
            for packet in stream.encode(small):
                out.mux(packet)
            encoded += 1
            if encoded >= count:
                break
        for packet in stream.encode():
            out.mux(packet)
    return (buffer.getvalue() if encoded else b""), encoded


class PreviewCache:
    """Preview segments on disk, so reopening an episode skips decoding. Oldest entries go first."""

    def __init__(self, limit_bytes: int) -> None:
        base = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
        self.root = base / "paseo-lerobot-rerun" / "previews"
        self.limit = limit_bytes

    def key(self, path: Path, start: float, end: float | None, width: int, fps: int) -> str:
        import hashlib

        stat = path.stat()
        raw = f"{path}|{stat.st_size}|{stat.st_mtime_ns}|{start}|{end}|{width}|{fps}|{SEGMENT_SECONDS}|{PREVIEW_VERSION}"
        return hashlib.sha1(raw.encode()).hexdigest()

    def segments(self, key: str) -> list[bytes] | None:
        folder = self.root / key
        if not (folder / "complete").is_file():
            return None
        os.utime(folder)
        return [p.read_bytes() for p in sorted(folder.glob("seg-*.mp4"))]

    def store(self, key: str, segments: list[bytes]) -> None:
        if self.limit <= 0:
            return
        try:
            temp = self.root / f"{key}.partial-{os.getpid()}"
            temp.mkdir(parents=True, exist_ok=True)
            for i, data in enumerate(segments):
                (temp / f"seg-{i:04d}.mp4").write_bytes(data)
            (temp / "complete").write_text("")
            shutil.rmtree(self.root / key, ignore_errors=True)
            temp.rename(self.root / key)
            self.prune()
        except OSError:
            pass  # the cache is an optimization

    def prune(self) -> None:
        entries = []
        for folder in self.root.iterdir():
            if folder.is_dir() and ".partial-" not in folder.name:
                size = sum(f.stat().st_size for f in folder.iterdir())
                entries.append((folder.stat().st_mtime, size, folder))
        total = sum(size for _, size, _ in entries)
        for _, size, folder in sorted(entries):
            if total <= self.limit:
                break
            shutil.rmtree(folder, ignore_errors=True)
            total -= size


class CameraPreview:
    """One camera's preview, produced segment by segment, from the cache when it has it."""

    def __init__(self, key: str, path: Path, start: float, end: float | None, fps: int, total: int, width: int, cache: PreviewCache):
        import av

        self.key = key
        with av.open(str(path)) as probe:
            stream = probe.streams.video[0]
            source_w, source_h = stream.width, stream.height
        self.width = min(width, source_w - source_w % 2)
        self.height = max(2, int(round(source_h * self.width / source_w / 2)) * 2)
        self.fps, self.total = fps, total
        self.cache = cache
        self.cache_key = cache.key(path, start, end, self.width, fps)
        self.cached = cache.segments(self.cache_key)
        self.frames = None if self.cached is not None else episode_frames(path, start, end, fps, total)
        self.made: list[bytes] = []
        self.index = 0

    def next_segment(self) -> tuple[bytes, int] | None:
        """The next segment's MP4 bytes and frame count, or None at the end."""
        if self.cached is not None:
            if self.index >= len(self.cached):
                return None
            data = self.cached[self.index]
            self.index += 1
            return data, -1  # count read from the video by the caller
        data, count = encode_segment(self.frames, self.fps * SEGMENT_SECONDS, self.width, self.height, self.fps)
        if count == 0:
            self.cache.store(self.cache_key, self.made)
            return None
        self.made.append(data)
        self.index += 1
        return data, count


class Rerun:
    """The parts of the Rerun API this script uses, across the 0.22 and 0.23+ naming."""

    def __init__(self) -> None:
        import rerun as rr
        import rerun.blueprint as rrb

        self.rr, self.rrb = rr, rrb

    def serve(self, web_port: int, data_port: int, host: str, blueprint) -> str:
        """Start the web viewer and its data server in this process; returns the viewer URL."""
        rr = self.rr
        if hasattr(rr, "serve_grpc"):  # 0.23 and later
            uri = rr.serve_grpc(grpc_port=data_port, default_blueprint=blueprint, server_memory_limit=SERVER_MEMORY)
            rr.serve_web_viewer(web_port=web_port, open_browser=False, connect_to=uri)
            source = uri.replace("127.0.0.1", host).replace("localhost", host)
        else:
            rr.serve_web(
                open_browser=False,
                web_port=web_port,
                ws_port=data_port,
                default_blueprint=blueprint,
                server_memory_limit=SERVER_MEMORY,
            )
            source = f"ws://{host}:{data_port}"
        return f"http://{host}:{web_port}/?url={quote(source, safe='')}"

    def indexes(self, frames: list[int], seconds: list[float]) -> list:
        rr = self.rr
        if hasattr(rr, "TimeColumn"):  # 0.23 and later
            return [rr.TimeColumn("frame", sequence=frames), rr.TimeColumn("time", duration=seconds)]
        return [rr.TimeSequenceColumn("frame", frames), rr.TimeSecondsColumn("time", seconds)]

    def set_frame(self, frame: int, seconds: float) -> None:
        rr = self.rr
        if hasattr(rr, "set_time"):
            rr.set_time("frame", sequence=frame)
            rr.set_time("time", duration=seconds)
        else:
            rr.set_time_sequence("frame", frame)
            rr.set_time_seconds("time", seconds)

    def send_scalars(self, path: str, frames: list[int], seconds: list[float], values) -> None:
        """One column of values for a whole episode: one call instead of one per frame."""
        rr = self.rr
        if hasattr(rr, "Scalars"):
            columns = rr.Scalars.columns(scalars=values)
        else:
            columns = rr.Scalar.columns(scalar=values)
        rr.send_columns(path, indexes=self.indexes(frames, seconds), columns=columns)

    def send_frame_references(self, path: str, frames: list[int], seconds: list[float], stamps_ns: list[int], video: str) -> None:
        rr = self.rr
        columns = rr.VideoFrameReference.columns(timestamp=stamps_ns, video_reference=[video] * len(stamps_ns))
        rr.send_columns(path, indexes=self.indexes(frames, seconds), columns=columns)

    def series_name(self, path: str, name: str) -> None:
        rr = self.rr
        style = rr.SeriesLines(names=name) if hasattr(rr, "SeriesLines") else rr.SeriesLine(name=name)
        rr.log(path, style, static=True)

    def frame_timestamps_ns(self, video) -> list[int]:
        read = getattr(video, "read_frame_timestamps_nanos", None) or video.read_frame_timestamps_ns
        return [int(t) for t in read()]


def log_video(api: Rerun, key: str, path: Path, start: float, end: float | None, seconds: list[float]) -> None:
    """Original quality: log one camera as the dataset's own video, cut without re-encoding."""
    rr = api.rr
    data, offset = remux_segment(path, start, end)
    video_path = f"_video/{key}/original"
    video = rr.AssetVideo(contents=data, media_type="video/mp4")
    rr.log(video_path, video, static=True)
    stamps = sorted(api.frame_timestamps_ns(video))
    if not stamps:
        raise ValueError("the video segment has no frames")
    # Episode frame i sits at start + (seconds[i] - seconds[0]) in the source file.
    base = seconds[0]
    chosen = []
    for second in seconds:
        target = int((start + (second - base) - offset) * 1e9)
        j = bisect.bisect_left(stamps, target)
        if j == len(stamps) or (j > 0 and target - stamps[j - 1] <= stamps[j] - target):
            j -= 1
        chosen.append(stamps[j])
    api.send_frame_references(key, list(range(len(seconds))), seconds, chosen, video_path)


def log_jpegs(api: Rerun, key: str, path: Path, start: float, end: float | None, seconds: list[float], fps: float, quality: int) -> None:
    rr = api.rr
    for i, frame in enumerate(episode_frames(path, start, end, fps, len(seconds))):
        buffer = io.BytesIO()
        frame.to_image().save(buffer, format="JPEG", quality=quality)
        api.set_frame(i, seconds[i])
        rr.log(key, rr.EncodedImage(contents=buffer.getvalue(), media_type="image/jpeg"))


def log_previews(api: Rerun, cameras: list["CameraPreview"], seconds: list[float]) -> None:
    """Log every camera's preview ten seconds at a time, all cameras together, from the start."""
    from concurrent.futures import ThreadPoolExecutor

    rr = api.rr
    offsets = {camera.key: 0 for camera in cameras}
    active = list(cameras)
    segment = 0
    segments_total = max(1, -(-len(seconds) // (cameras[0].fps * SEGMENT_SECONDS))) if cameras else 1
    with ThreadPoolExecutor(max_workers=max(1, len(cameras))) as pool:
        while active:
            results = list(pool.map(lambda camera: camera.next_segment(), active))
            for camera, result in zip(list(active), results):
                if result is None:
                    active.remove(camera)
                    continue
                data, _ = result
                video_path = f"_video/{camera.key}/{segment:04d}"
                video = rr.AssetVideo(contents=data, media_type="video/mp4")
                rr.log(video_path, video, static=True)
                stamps = sorted(api.frame_timestamps_ns(video))
                first = offsets[camera.key]
                stamps = stamps[: max(0, len(seconds) - first)]
                frames = list(range(first, first + len(stamps)))
                if frames:
                    api.send_frame_references(camera.key, frames, [seconds[i] for i in frames], stamps, video_path)
                offsets[camera.key] = first + len(stamps)
            segment += 1
            emit({"event": "progress", "done": min(segment, segments_total), "total": segments_total, "stage": "cameras"})


def export(args: argparse.Namespace) -> None:
    """Log one episode to an .rrd file (`export`), or serve it live while logging (`serve`)."""
    import numpy as np

    dataset = Dataset(args.root)
    row = dataset.episode_row(args.episode)
    api = Rerun()
    rr, rrb = api.rr, api.rrb

    table = dataset.frames(row)
    total = table.num_rows
    if total == 0:
        raise ValueError(f"Episode {args.episode} has no frames")

    cameras = dataset.video_keys + [k for k in dataset.image_keys if k in table.column_names]
    scalar_keys: list[tuple[str, int]] = []
    for key, feature in dataset.features.items():
        if key in INDEX_COLUMNS or key not in table.column_names:
            continue
        if feature.get("dtype") in ("video", "image", "string"):
            continue
        shape = feature.get("shape") or [1]
        if len(shape) == 1 and int(shape[0]) <= MAX_SCALAR_DIMS:
            scalar_keys.append((key, int(shape[0])))

    # Few plots on screen by default: actions and states first; among the rest, vectors such as
    # positions and poses before single flags or confidences, and small before large.
    def rank(item: tuple[str, int]) -> tuple:
        key, dims = item
        group = 0 if key.startswith("action") else 1 if key == "observation.state" else 2
        return (dims > VISIBLE_PLOT_DIMS, group, dims == 1, dims, key)

    ordered = sorted(scalar_keys, key=rank)
    shown = {key for key, dims in ordered[:VISIBLE_PLOTS] if dims <= VISIBLE_PLOT_DIMS} or {key for key, _ in ordered[:1]}
    plots = [rrb.TimeSeriesView(origin=f"/{key}", name=key, visible=key in shown) for key, _ in ordered]
    views = [rrb.Spatial2DView(origin=f"/{key}", name=key.split(".")[-1]) for key in cameras]
    # Cameras side by side on top, plots below; hidden plots can be shown from the blueprint panel.
    rows = []
    if views:
        rows.append(rrb.Horizontal(*views))
    if plots:
        rows.append(rrb.Horizontal(*plots))
    blueprint = rrb.Blueprint(rrb.Vertical(*rows), collapse_panels=True) if rows else None

    name = dataset.root.name
    rr.init(f"lerobot/{name}", recording_id=f"{name}-episode-{args.episode}-{args.quality}")
    live = args.command == "serve"
    if live:
        exit_when_parent_closes_stdin()
        url = api.serve(args.web_port, args.data_port, args.host, blueprint)
        emit({"event": "ready", "url": url, "frames": total, "rerun": rr.__version__})
    else:
        rr.save(args.out, default_blueprint=blueprint)

    tasks = [str(t) for t in (row.get("tasks") or [])]
    if not tasks and "task_index" in table.column_names:
        known = dataset._tasks_v2()
        tasks = [known[i] for i in sorted(set(table.column("task_index").to_pylist())) if i in known]
    if tasks:
        rr.log("task", rr.TextDocument("\n".join(tasks)), static=True)

    if "timestamp" in table.column_names:
        seconds = [float(t) for t in table.column("timestamp").to_pylist()]
    else:
        seconds = [i / dataset.fps for i in range(total)]
    frames = list(range(total))

    def log_plots(keys: list[tuple[str, int]]) -> None:
        for key, dims in keys:
            names = dim_names(dataset.features[key], dims)
            values = np.array(
                [v if isinstance(v, list) else [v] for v in table.column(key).to_pylist()], dtype=np.float64
            ).reshape(total, -1)
            for d, name_ in enumerate(names[: values.shape[1]]):
                api.series_name(f"{key}/{name_}", name_)
                api.send_scalars(f"{key}/{name_}", frames, seconds, values[:, d])

    # The viewer takes in data in the order it is sent. Plots on screen go first (they are small),
    # then the cameras, then the hidden plots, which can be much larger than the video.
    log_plots([item for item in scalar_keys if item[0] in shown])

    for key in dataset.image_keys:
        if key not in table.column_names:
            continue
        for i, cell in enumerate(table.column(key).to_pylist()):
            data = cell.get("bytes") if isinstance(cell, dict) else None
            if data:
                api.set_frame(i, seconds[i])
                rr.log(key, rr.EncodedImage(contents=data))

    encodings: dict[str, str] = {}
    fps = int(round(dataset.fps))
    sources = []
    for key in dataset.video_keys:
        path, start, end = dataset.video(row, key)
        if not path.is_file():
            emit({"event": "warning", "message": f"Missing video file: {path}"})
            continue
        sources.append((key, path, start, end))

    if args.quality == "preview":
        cache = PreviewCache(int(args.cache_gb * 1e9))
        previews = [CameraPreview(key, path, start, end, fps, total, args.preview_width, cache) for key, path, start, end in sources]
        log_previews(api, previews, seconds)
        encodings = {p.key: f"preview {p.width}x{p.height}" + (" (cached)" if p.cached is not None else "") for p in previews}
    else:
        for n, (key, path, start, end) in enumerate(sources):
            emit({"event": "progress", "done": n, "total": len(sources), "stage": key})
            try:
                log_video(api, key, path, start, end, seconds)
                encodings[key] = "original"
                continue
            except Exception as error:  # codec the viewer cannot decode: send frames instead
                emit({"event": "warning", "message": f"{key}: sending JPEG frames ({error})"})
            log_jpegs(api, key, path, start, end, seconds, dataset.fps, args.jpeg_quality)
            encodings[key] = "jpeg"

    log_plots([item for item in scalar_keys if item[0] not in shown])

    if live:
        emit({"event": "loaded", "frames": total, "encodings": encodings})
        while True:  # serve until the plugin closes stdin
            time.sleep(3600)
    if hasattr(rr, "disconnect"):
        rr.disconnect()  # flushes the file sink
    emit(
        {
            "event": "exported",
            "frames": total,
            "bytes": os.path.getsize(args.out),
            "encodings": encodings,
            "rerun": rr.__version__,
        }
    )


def cell_text(value, limit: int = 160) -> str:
    """One table cell: short, single line; long lists and binary values are summarized."""
    if value is None:
        return "null"
    if isinstance(value, (bytes, bytearray)):
        return f"<{len(value)} bytes>"
    if isinstance(value, float):
        return f"{value:.6g}"
    if isinstance(value, (list, tuple)):
        head = ", ".join(cell_text(v, 24) for v in value[:8])
        more = f", … ({len(value)} items)" if len(value) > 8 else ""
        return f"[{head}{more}]"
    if isinstance(value, dict):
        text = json.dumps(value, default=str, ensure_ascii=False)
    else:
        text = str(value)
    text = text.replace("\n", " ")
    return text if len(text) <= limit else text[: limit - 1] + "…"


def read_parquet(path: str, offset: int, limit: int) -> dict:
    """Schema and rows [offset, offset + limit) of a Parquet file, reading only the row groups needed."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    file = pq.ParquetFile(path)
    meta = file.metadata
    total = meta.num_rows
    offset = max(0, min(offset, total))
    end = min(total, offset + limit)
    batches, start = [], 0
    for group in range(meta.num_row_groups):
        size = meta.row_group(group).num_rows
        if start + size > offset and start < end:
            table = file.read_row_group(group)
            lo, hi = max(offset - start, 0), min(end - start, size)
            batches.append(table.slice(lo, hi - lo))
        start += size
        if start >= end:
            break
    table = pa.concat_tables(batches) if batches else file.schema_arrow.empty_table()
    columns = [{"name": field.name, "type": str(field.type)} for field in file.schema_arrow]
    rows = [[cell_text(row.get(c["name"])) for c in columns] for row in table.to_pylist()]
    return {
        "numRows": total,
        "rowGroups": meta.num_row_groups,
        "offset": offset,
        "columns": columns,
        "rows": rows,
        "metadata": {k.decode(errors="replace"): v.decode(errors="replace")[:2000] for k, v in (file.schema_arrow.metadata or {}).items() if k != b"ARROW:schema"},
    }


def exit_when_parent_closes_stdin() -> None:
    def watch() -> None:
        try:
            while sys.stdin.buffer.read(4096):
                pass
        finally:
            os._exit(0)

    threading.Thread(target=watch, daemon=True).start()


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("", 0))
        return probe.getsockname()[1]


def rerun_binary() -> str:
    try:
        import rerun_cli

        path = Path(rerun_cli.__file__).parent / ("rerun.exe" if os.name == "nt" else "rerun")
        if path.is_file():
            return str(path)
    except ImportError:
        pass
    found = shutil.which("rerun")
    if not found:
        raise FileNotFoundError("The rerun viewer binary was not found. Install rerun-sdk.")
    return found


def view(args: argparse.Namespace) -> None:
    """Serve an .rrd file in the Rerun web viewer until stdin closes."""
    web_port, data_port = args.web_port, args.data_port
    child = subprocess.Popen(
        [
            rerun_binary(),
            "--serve-web",
            "--web-viewer-port", str(web_port),
            "--ws-server-port", str(data_port),
            "--port", str(free_port()),
            "--server-memory-limit", args.memory_limit,
            args.rrd,
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )

    def stop(*_args) -> None:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(5)
            except subprocess.TimeoutExpired:
                child.kill()
        os._exit(0)

    signal.signal(signal.SIGTERM, stop)

    def watch_parent() -> None:
        try:
            while sys.stdin.buffer.read(4096):
                pass
        finally:
            stop()

    threading.Thread(target=watch_parent, daemon=True).start()

    deadline = time.monotonic() + 30
    while True:
        if child.poll() is not None:
            detail = (child.stderr.read() if child.stderr else b"").decode(errors="replace").strip()
            raise RuntimeError(detail.splitlines()[-1] if detail else f"rerun exited with code {child.returncode}")
        try:
            with socket.create_connection(("127.0.0.1", web_port), timeout=1):
                break
        except OSError:
            if time.monotonic() > deadline:
                stop()
            time.sleep(0.2)

    source = f"ws://{args.host}:{data_port}"
    emit({"event": "ready", "url": f"http://{args.host}:{web_port}/?url={quote(source, safe='')}"})
    child.wait()
    raise RuntimeError(f"rerun exited with code {child.returncode}")


def main() -> None:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("check")
    episodes = commands.add_parser("episodes")
    episodes.add_argument("--root", required=True)
    serving = commands.add_parser("serve", help="serve one episode live while logging it")
    serving.add_argument("--root", required=True)
    serving.add_argument("--episode", type=int, required=True)
    serving.add_argument("--web-port", type=int, required=True)
    serving.add_argument("--data-port", type=int, required=True)
    serving.add_argument("--host", default="localhost")
    exporting = commands.add_parser("export")
    exporting.add_argument("--root", required=True)
    exporting.add_argument("--episode", type=int, required=True)
    exporting.add_argument("--out", required=True)
    for command in (serving, exporting):
        command.add_argument("--quality", choices=["preview", "original"], default="preview")
        command.add_argument("--preview-width", type=int, default=PREVIEW_WIDTH)
        command.add_argument("--cache-gb", type=float, default=5.0, help="preview cache size; 0 disables it")
        command.add_argument("--jpeg-quality", type=int, default=80)
    parquet = commands.add_parser("parquet", help="schema and a page of rows of a Parquet file")
    parquet.add_argument("--path", required=True)
    parquet.add_argument("--offset", type=int, default=0)
    parquet.add_argument("--limit", type=int, default=100)
    viewing = commands.add_parser("view")
    viewing.add_argument("--rrd", required=True)
    viewing.add_argument("--web-port", type=int, required=True)
    viewing.add_argument("--data-port", type=int, required=True)
    viewing.add_argument("--host", default="localhost")
    viewing.add_argument("--memory-limit", default="25%")
    args = parser.parse_args()

    try:
        if args.command == "check":
            import av  # noqa: F401
            import PIL  # noqa: F401
            import pyarrow  # noqa: F401
            import rerun

            emit({"ok": True, "rerun": rerun.__version__})
        elif args.command == "episodes":
            emit({"episodes": Dataset(args.root).list_episodes()})
        elif args.command == "parquet":
            emit({"ok": True, **read_parquet(args.path, args.offset, min(args.limit, 1000))})
        elif args.command in ("export", "serve"):
            export(args)
        else:
            view(args)
    except Exception as error:  # reported to the plugin, which shows it to the user
        emit({"event": "error", "ok": False, "message": f"{type(error).__name__}: {error}"})
        sys.exit(1)


if __name__ == "__main__":
    main()
