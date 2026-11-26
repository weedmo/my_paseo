// Files of a connected folder: list, read and write, never outside the folder.
import { open, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { FileEntry, FileText } from "../shared/rpc";
import { expandHome } from "./datasets";

/** Larger files open read-only with only their start shown. */
export const MAX_EDIT_BYTES = 2 * 1024 * 1024;
const MAX_LIST = 2000;

/** The absolute path of `path` (relative to `root`, or absolute) if it is inside `root`. */
async function inside(root: string, path: string): Promise<{ root: string; full: string }> {
  const base = await realpath(expandHome(root));
  const target = resolve(base, path);
  // Resolve symlinks when the target exists, so a link cannot lead outside the folder.
  const real = await realpath(target).catch(() => target);
  const rel = relative(base, real);
  if (rel.startsWith("..") || rel.startsWith(sep) || resolve(base, rel) !== real) {
    throw new Error("That path is outside the connected folder.");
  }
  return { root: base, full: real };
}

export async function listFiles(root: string, path: string): Promise<{ path: string; entries: FileEntry[]; truncated: boolean }> {
  const { root: base, full } = await inside(root, path);
  const names = await readdir(full, { withFileTypes: true });
  const entries: FileEntry[] = [];
  for (const entry of names.slice(0, MAX_LIST)) {
    if (entry.name === "@eaDir" || entry.name === "#recycle") continue;
    const child = join(full, entry.name);
    const info = await stat(child).catch(() => null);
    if (!info) continue;
    entries.push({
      name: entry.name,
      path: relative(base, child),
      kind: info.isDirectory() ? "folder" : "file",
      size: info.isDirectory() ? 0 : info.size,
      modifiedMs: info.mtimeMs,
    });
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.kind === "folder" ? -1 : 1));
  return { path: relative(base, full), entries, truncated: names.length > MAX_LIST };
}

function looksBinary(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 8000);
  return sample.includes(0);
}

export async function readFileText(root: string, path: string): Promise<FileText> {
  const { full } = await inside(root, path);
  const info = await stat(full);
  if (!info.isFile()) throw new Error("Not a file.");
  const handle = await open(full, "r");
  try {
    const length = Math.min(info.size, MAX_EDIT_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    const binary = looksBinary(buffer);
    return {
      size: info.size,
      modifiedMs: info.mtimeMs,
      binary,
      truncated: info.size > MAX_EDIT_BYTES,
      text: binary ? "" : buffer.toString("utf8"),
    };
  } finally {
    await handle.close();
  }
}

/** Writes when the file is unchanged since `expectedModifiedMs`, unless `force`. */
export async function writeFileText(
  root: string,
  path: string,
  text: string,
  expectedModifiedMs: number | null,
  force: boolean,
): Promise<{ modifiedMs: number; size: number }> {
  const { full } = await inside(root, path);
  const current = await stat(full).catch(() => null);
  if (current && !current.isFile()) throw new Error("Not a file.");
  if (current && current.size > MAX_EDIT_BYTES) throw new Error("This file is too large to edit here.");
  if (!force && current && expectedModifiedMs !== null && Math.abs(current.mtimeMs - expectedModifiedMs) > 1) {
    throw new Error("CONFLICT: the file changed on the host since it was opened.");
  }
  await writeFile(full, text, "utf8");
  const after = await stat(full);
  return { modifiedMs: after.mtimeMs, size: after.size };
}
