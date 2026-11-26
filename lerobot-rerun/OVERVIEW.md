Connect LeRobot dataset folders on this computer or on other computers connected to Paseo, and open any episode in the Rerun web viewer. Connected folders are listed under **LeRobot datasets** in the sidebar, like workspaces. The viewer shows every camera side by side, with the state and action values plotted below on the same timeline.

## How it works

**Connect folder** opens a folder browser for any host: shortcuts to the home folder, the Hugging Face cache and mounted drives such as a NAS under `/mnt`, a path field, and breadcrumbs. Folders that are LeRobot datasets (they contain `meta/info.json`) are marked with their episode count. Connect a dataset folder, or a folder that holds several datasets; the second kind is searched up to six levels deep and lists its datasets with a name filter. Connections are kept on this device.

Episodes are shown without copying them first. When you pick an episode, the host that holds the dataset starts a Rerun viewer there and logs the episode into it while it serves, so the viewer opens within a second and fills in as data arrives: the plots on screen first, then the cameras ten seconds at a time from the start, then the hidden plots.

By default cameras are sent as a **smooth preview**: re-encoded to 640 pixels wide H.264 without B-frames and with a keyframe every second, which any computer decodes easily. The host uses a hardware encoder when one works (NVIDIA, Intel Quick Sync, Apple) and otherwise the CPU. Previews are cached on the dataset host (5 GB, oldest removed first), so reopening an episode takes about a second. For a five-minute episode with four 1920x1200 cameras, the preview is about 100 MB instead of 1.2 GB. **Original quality** sends the dataset's own AV1 or H.264 video cut to the episode without re-encoding, and falls back to JPEG frames for other codecs.

Only a few plots are shown at first: actions and states, then other vectors such as positions and poses, up to 16 values each. Every numeric feature is still logged, and hidden plots can be shown from the Rerun blueprint panel.

For a dataset on another computer, the plugin relays that host's viewer through a port on localhost of this computer. Browsers decode video only on secure origins such as localhost, so a viewer opened at the other computer's network address would show no video. This needs a direct network path to the other computer, which the plugin takes from the host's `ssh://` or `tcp://` connection. When that path is missing, as with relay connections or blocked ports, the plugin falls back to copying the episode as an `.rrd` file through Paseo's connection and serving it here.

Viewers run on the host that serves the dataset screen, normally this computer, up to four at once; opening a fifth closes the oldest.

## Each connection works like a workspace

Opening a connected folder shows it like a workspace, without creating a Paseo workspace: its file tree on the left, its own tabs on top, and the active tab on the right. The **Episodes** tab lists datasets and episodes. Files from the tree open as more tabs: text files such as `info.json`, `.jsonl`, `.csv` or scripts in an editor that saves back to the host, and `.parquet` files as a read-only table, a hundred rows per page, with the schema and file metadata. Each connection remembers its open tabs on this device. Saving refuses to overwrite a file that changed on the host since it was opened, and offers to reload or overwrite. Files larger than 2 MB open read only. The plugin only reads and writes inside the connected folder.

Rerun viewers are web pages, which Paseo can show only as browser tabs of a workspace, and a plugin cannot bring an existing browser tab forward. So all viewers live in one **LeRobot viewer** page with tabs of its own, one per episode, named such as `Episode 3 · stamp_v2`. Opening an episode that is already open switches to its tab instead of opening another one; the page's title follows the episode shown. In the desktop app the page is a browser tab of one shared **viewer** workspace in `~/.local/share/paseo-lerobot-rerun/viewer` on this computer, opened again only when it was closed. On web and mobile it opens in the system browser.

The sidebar lists connected folders under **LeRobot datasets**, which toggles the list. A folder expands into its episodes (or its datasets, then their episodes); pressing an episode opens its viewer, and the ✕ on a folder disconnects it after a confirmation. Disconnecting only removes the folder from the list and the sidebar; files on the host are not touched.

Hosts set up with `scripts/install-host.sh` are dataset hosts: their plugin serves episodes and files to this computer but does not show the dataset screen or sidebar, so the app always opens them on the computer it runs on.

## Setup

Every host that holds datasets, and the host that runs the viewer, needs this plugin and a Python interpreter with `rerun-sdk`, `pyarrow`, `av` and `pillow`. When none is found, the plugin creates its own environment in `~/.local/share/paseo-lerobot-rerun/venv` the first time it is needed (about a minute; it needs `python3` with `venv` and access to PyPI). The `lerobot` package is not required. Use the same `rerun-sdk` version on all hosts, because a recording written by one version may not open in another. With the Python path setting empty, the plugin tries `python3` on PATH and then every conda environment in the home folder.

To reach another computer, register it as a host on this computer's daemon, for example with `paseo host add`. Hosts registered there appear as buttons at the top of the dataset screen.

## Settings

- Dataset folders (per host): folders always searched on that host, up to six levels deep. The default is `~/.cache/huggingface/lerobot`.
- Connected folders: kept on this device and managed from the dataset screen.
- Python path: interpreter to use instead of the automatic search.
- Viewer host name: the name the app uses to reach the viewer host. Keep `localhost` when the app and the viewer host are the same computer.

## Limits

- Dataset formats v2.x and v3.0 are supported. Only v3.0 with AV1 and H.264 video and Rerun SDK 0.22 has been tested. In original quality, the last two frames of an episode at the very end of a B-frame video file can show a neighboring frame; the preview is not affected.
- Datasets are read from disk. Hugging Face Hub repositories are not downloaded.
- To reach other hosts, the plugin opens its own connection to this computer's daemon on its `host:port` listen address with the daemon's local credential. A daemon that listens only on a socket cannot reach other hosts.
- The Rerun servers listen on all network interfaces of the viewer host without authentication while a viewer runs. Anyone who can reach those ports can see the open episode.
- In the copying fallback, exported recordings stay in a temporary folder on the dataset host until two newer ones exist or the plugin stops, and the copy on the viewer host is deleted when the viewer stops.
- Video is sent at its original resolution. A five-minute episode with four 1920x1200 H.264 cameras is about 1.3 GB, so its cameras take about a minute to appear on a LAN even though the viewer opens at once.
- A host serving a viewer for another computer keeps the episode in memory until that viewer stops or the requesting plugin stops.
- Parquet files are read only. The table shows values as text, shortens long lists, and reads only the row groups of the page shown.
