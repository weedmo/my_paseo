// A folder browser for picking dataset folders on a host.
import { readdir, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import type { FolderListing } from "../shared/rpc";
import { eachLimited, expandHome, readDataset } from "./datasets";

const MAX_ENTRIES = 500;
/** Checking each subfolder for meta/info.json is slow on network drives; stop after this long. */
const CHECK_BUDGET_MS = 8_000;
const HIDDEN = new Set(["@eaDir", "#recycle", "lost+found", "node_modules", "__pycache__"]);

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function shortcuts(): Promise<FolderListing["shortcuts"]> {
  const list = [{ label: "Home", path: homedir() }];
  const cache = join(homedir(), ".cache", "huggingface", "lerobot");
  if (await isDirectory(cache)) list.push({ label: "Hugging Face cache", path: cache });
  // Mounted drives, such as a NAS under /mnt.
  for (const base of ["/mnt", join("/media", userInfo().username)]) {
    try {
      for (const entry of await readdir(base, { withFileTypes: true })) {
        if (entry.isDirectory() && !HIDDEN.has(entry.name)) list.push({ label: entry.name, path: join(base, entry.name) });
      }
    } catch {
      // No such mount folder.
    }
  }
  list.push({ label: "/", path: "/" });
  return list;
}

export async function listFolder(raw: string | undefined): Promise<FolderListing> {
  const path = raw?.trim() ? expandHome(raw) : homedir();
  if (!(await isDirectory(path))) throw new Error(`Not a folder: ${raw}`);

  const names: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || HIDDEN.has(entry.name)) continue;
    if (entry.isDirectory() || (entry.isSymbolicLink() && (await isDirectory(join(path, entry.name))))) names.push(entry.name);
  }
  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  let truncated = names.length > MAX_ENTRIES;

  const entries: FolderListing["entries"] = names.slice(0, MAX_ENTRIES).map((name) => ({ name, path: join(path, name), dataset: null }));
  const deadline = Date.now() + CHECK_BUDGET_MS;
  const parentName = basename(path) || path;
  await eachLimited(entries, 16, async (entry) => {
    if (Date.now() > deadline) {
      truncated = true;
      return;
    }
    entry.dataset = await readDataset(entry.path, path).catch(() => null);
  });

  const self = await readDataset(path, dirname(path)).catch(() => null);
  return {
    path,
    parent: path === "/" ? null : dirname(path),
    dataset: self ? { ...self, name: parentName } : null,
    entries,
    truncated,
    shortcuts: await shortcuts(),
  };
}
