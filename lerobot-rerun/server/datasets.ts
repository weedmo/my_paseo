import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import type { Dataset } from "../shared/rpc";

const MAX_DEPTH = 6;
const MAX_FOLDERS = 20_000;
/** Plugin RPCs time out after 30 seconds, and a remote search is relayed through two of them. */
const SEARCH_BUDGET_MS = 20_000;
const PARALLEL_READS = 16;
// Dataset contents, tooling folders, and NAS system folders (Synology @eaDir and #recycle).
const SKIP = new Set(["node_modules", ".git", "videos", "data", "meta", "images", "__pycache__", ".venv", "@eaDir", "#recycle", ".habilis"]);

export function expandHome(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

export async function readDataset(folder: string, root: string): Promise<Dataset | null> {
  let text: string;
  try {
    text = await readFile(join(folder, "meta", "info.json"), "utf8");
  } catch {
    return null;
  }
  const info = JSON.parse(text) as Record<string, unknown>;
  if (typeof info.codebase_version !== "string") return null;
  const features = (info.features ?? {}) as Record<string, { dtype?: string }>;
  return {
    path: folder,
    name: relative(root, folder) || basename(folder),
    version: info.codebase_version,
    episodes: Number(info.total_episodes ?? 0),
    frames: Number(info.total_frames ?? 0),
    fps: Number(info.fps ?? 0),
    robotType: typeof info.robot_type === "string" ? info.robot_type : null,
    cameras: Object.keys(features).filter((key) => ["video", "image"].includes(features[key].dtype ?? "")),
  };
}

/** Runs `work` over `items` with at most `limit` in flight. */
export async function eachLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  });
  await Promise.all(runners);
}

/**
 * Finds every dataset under the roots, breadth first. A dataset folder is not searched for nested
 * datasets. Network drives are slow to list, so folders are read in parallel and the search stops
 * after a time budget with what it found so far.
 */
export async function findDatasets(roots: readonly string[]): Promise<{ datasets: Dataset[]; errors: string[] }> {
  const found = new Map<string, Dataset>();
  const errors: string[] = [];
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  let visited = 0;
  for (const raw of roots) {
    if (!raw.trim()) continue;
    const root = expandHome(raw);
    try {
      if (!(await stat(root)).isDirectory()) throw new Error("not a folder");
    } catch {
      errors.push(`Folder not found: ${raw}`);
      continue;
    }
    let level = [root];
    let depth = 0;
    for (; depth <= MAX_DEPTH && level.length > 0; depth++) {
      if (Date.now() > deadline || visited > MAX_FOLDERS) break;
      const next: string[] = [];
      await eachLimited(level, PARALLEL_READS, async (folder) => {
        if (Date.now() > deadline || ++visited > MAX_FOLDERS) return;
        try {
          const dataset = await readDataset(folder, root);
          if (dataset) {
            found.set(dataset.path, dataset);
            return;
          }
          for (const entry of await readdir(folder, { withFileTypes: true })) {
            if (entry.isDirectory() && !SKIP.has(entry.name)) next.push(join(folder, entry.name));
          }
        } catch (error) {
          // Unreadable folders and broken info.json files are reported, not fatal.
          if ((error as NodeJS.ErrnoException).code !== "EACCES") errors.push(`${folder}: ${(error as Error).message}`);
        }
      });
      level = next;
    }
    if (level.length > 0 && depth <= MAX_DEPTH) {
      const why = visited > MAX_FOLDERS ? `${MAX_FOLDERS} folders` : `${SEARCH_BUDGET_MS / 1000} seconds`;
      errors.push(`Search of ${raw} stopped after ${why}, ${depth} levels deep. Add a narrower folder to find deeper datasets.`);
    }
  }
  const datasets = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { datasets, errors: errors.slice(0, 10) };
}
