// The host that holds a dataset turns an episode into an .rrd file that any viewer host can fetch.
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExportStatus, Quality } from "../shared/rpc";
import { type Python, readEvents } from "./python";

/** Finished exports kept for reopening; episodes with large videos can be gigabytes each. */
const KEEP = 2;

interface Entry {
  id: string;
  key: string;
  file: string;
  status: ExportStatus;
  child: ChildProcess | null;
  finished: Promise<ExportStatus>;
}

export class Exports {
  private readonly entries = new Map<string, Entry>();
  private readonly python: Python;

  constructor(python: Python) {
    this.python = python;
  }

  /** Starts an export, or reuses a running or finished one of the same episode. */
  async start(root: string, episode: number, quality: Quality, pythonSetting: string): Promise<Entry> {
    const key = `${root}\n${episode}\n${quality}`;
    for (const entry of this.entries.values()) {
      if (entry.key === key && entry.status.state !== "error") return entry;
    }
    const id = randomUUID();
    const file = join(await this.python.workDir(), `export-${id}.rrd`);
    const status: ExportStatus = { state: "running", done: 0, total: 1, bytes: 0, message: null, rerun: null };
    const child = await this.python.spawn(pythonSetting, ["export", "--root", root, "--episode", String(episode), "--quality", quality, "--out", file]);
    child.stdin?.end();
    const entry: Entry = { id, key, file, status, child, finished: Promise.resolve(status) };
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    readEvents(child, (event) => {
      if (event.event === "progress") {
        entry.status = { ...entry.status, done: Number(event.done), total: Number(event.total) };
      } else if (event.event === "warning") {
        entry.status = { ...entry.status, message: String(event.message) };
      } else if (event.event === "exported") {
        entry.status = { ...entry.status, bytes: Number(event.bytes), rerun: String(event.rerun) };
      } else if (event.event === "error") {
        entry.status = { ...entry.status, state: "error", message: String(event.message) };
      }
    });
    entry.finished = new Promise<ExportStatus>((done) => {
      const finish = (error?: string) => {
        entry.child = null;
        if (entry.status.state === "running") {
          entry.status = error
            ? { ...entry.status, state: "error", message: error }
            : { ...entry.status, state: "done", done: entry.status.total };
        }
        done(entry.status);
      };
      child.once("error", (error) => finish(`Could not start Python: ${error.message}`));
      child.once("exit", (code) => finish(code === 0 ? undefined : stderr.trim().split("\n").pop() || `export exited with code ${code}`));
    });
    this.entries.set(id, entry);
    await this.prune();
    return entry;
  }

  status(id: string): ExportStatus {
    return this.require(id).status;
  }

  async read(id: string, offset: number, length: number): Promise<Uint8Array> {
    const entry = this.require(id);
    if (entry.status.state !== "done") throw new Error("The export is not finished.");
    const handle = await open(entry.file, "r");
    try {
      const buffer = Buffer.alloc(Math.min(length, Math.max(0, entry.status.bytes - offset)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
    } finally {
      await handle.close();
    }
  }

  file(id: string): string {
    return this.require(id).file;
  }

  async size(id: string): Promise<number> {
    return (await stat(this.require(id).file)).size;
  }

  stop(): void {
    for (const entry of this.entries.values()) entry.child?.kill("SIGTERM");
  }

  private require(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Unknown or expired export. Open the episode again.");
    return entry;
  }

  /** Keeps the newest exports; older files are deleted. */
  private async prune(): Promise<void> {
    const old = [...this.entries.values()].slice(0, Math.max(0, this.entries.size - KEEP));
    for (const entry of old) {
      if (entry.child) continue;
      this.entries.delete(entry.id);
      await rm(entry.file, { force: true });
    }
  }
}
