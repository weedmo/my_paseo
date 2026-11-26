import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `run-graph-${name}-`));
}

/** Copy a fixture file, replacing placeholders, and stamp its mtime. */
export function place(src: string, dest: string, vars: Record<string, string> = {}, mtime?: number): void {
  mkdirSync(dirname(dest), { recursive: true });
  let text = readFileSync(join(FIXTURES, src), "utf8");
  for (const [k, v] of Object.entries(vars)) text = text.split(k).join(v);
  writeFileSync(dest, text);
  if (mtime != null) utimesSync(dest, mtime / 1000, mtime / 1000);
}

export function placeDir(src: string, dest: string, vars: Record<string, string> = {}, mtime?: number): void {
  for (const f of readdirSync(join(FIXTURES, src))) place(join(src, f), join(dest, f), vars, mtime);
  if (mtime != null) utimesSync(dest, mtime / 1000, mtime / 1000);
}

export function write(dest: string, text: string, mtime?: number): void {
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, text);
  if (mtime != null) utimesSync(dest, mtime / 1000, mtime / 1000);
}

export { copyFileSync };
