const pad2 = (n: number) => String(n).padStart(2, "0");

export function dur(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${pad2(s % 60)}s`;
  return `${Math.floor(s / 3600)}h${pad2(Math.floor((s % 3600) / 60))}m`;
}

export function ago(ms: number, now: number): string {
  const s = (now - ms) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function itemDuration(start: number | null, end: number | null, running: boolean, now: number): string {
  if (start == null) return "";
  const e = end ?? (running ? now : null);
  return e == null ? "" : dur(e - start);
}
