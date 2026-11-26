import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";

export const TAIL_BYTES = 131072;

export function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function readText(path: string, maxBytes = 4 * 1024 * 1024): string | null {
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(size, maxBytes));
      readSync(fd, buf, 0, buf.length, 0);
      return buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function readJson(path: string): unknown {
  const text = readText(path);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** First line and the last `tail` bytes, never the whole transcript. */
export function headAndTail(path: string, tail = TAIL_BYTES): { head: string; tail: string; size: number } | null {
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const headBuf = Buffer.alloc(Math.min(size, 65536));
      readSync(fd, headBuf, 0, headBuf.length, 0);
      const headText = headBuf.toString("utf8");
      const nl = headText.indexOf("\n");
      const start = Math.max(0, size - tail);
      const tailBuf = Buffer.alloc(size - start);
      readSync(fd, tailBuf, 0, tailBuf.length, start);
      return { head: nl >= 0 ? headText.slice(0, nl) : headText, tail: tailBuf.toString("utf8"), size };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Cache a parse by file mtime: unchanged files are not read again. */
export class MtimeCache<T> {
  private map = new Map<string, { key: string; value: T }>();
  get(path: string, stamp: string, make: () => T): T {
    const hit = this.map.get(path);
    if (hit && hit.key === stamp) return hit.value;
    const value = make();
    this.map.set(path, { key: stamp, value });
    return value;
  }
  clear(): void {
    this.map.clear();
  }
}

export const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
export const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function isoMs(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** Claude names a project dir after its cwd with every non-alphanumeric character as "-". */
export const encodeCwd = (path: string): string => path.replace(/[^A-Za-z0-9]/g, "-");

export const clip = (s: string | null | undefined, n = 600): string => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : "");

export function kilo(n: number | null | undefined): string {
  if (n == null) return "";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}
