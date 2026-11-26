// The daemon-side service behind the RPCs: find the repo's checkouts, read
// every run, cache each parse by file mtime, and link the runs.
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Edge, Run } from "../shared/model.ts";
import { encodeCwd, isDir, mtimeMs, MtimeCache } from "./fsutil.ts";
import { linkRuns, type LoopHint } from "./link.ts";
import { discoverLoops, loopStampPaths, readLoop, type LoopFile, type LoopRead } from "./loops.ts";
import {
  discoverSessions,
  discoverWorkflows,
  inCheckouts,
  readSession,
  readWorkflow,
  sessionStamp,
  workflowStamp,
  type RawSession,
  type RawWorkflowRun,
  type WorkflowRead,
} from "./workflow.ts";

export interface ServiceOptions {
  claudeRoot?: string;
  home?: string;
  now?: () => number;
  /** git is replaced in tests. */
  git?: (args: string[]) => string | null;
}

export interface ListResult {
  repoRoot: string | null;
  checkouts: string[];
  runs: Run[];
  edges: Edge[];
  errors: string[];
  readAt: number;
}

type Source = { kind: "workflow"; raw: RawWorkflowRun } | { kind: "session"; raw: RawSession } | { kind: "loop"; file: LoopFile };

export function repoRoot(folder: string): string | null {
  let d = folder;
  for (;;) {
    if (mtimeMs(join(d, ".git")) != null) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

function defaultGit(args: string[]): string | null {
  try {
    return execFileSync("git", args, { timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

export class RunService {
  private claudeRoot: string;
  private home: string;
  private now: () => number;
  private git: (args: string[]) => string | null;
  private workflowCache = new MtimeCache<WorkflowRead>();
  private loopCache = new MtimeCache<LoopRead>();
  private checkoutCache = new Map<string, { at: number; list: string[] }>();
  private headCache = new Map<string, { at: number; sha: string | null }>();
  /** runId -> where it came from, for runDetail. Only ids listed before can be read. */
  private sources = new Map<string, Source>();

  constructor(opts: ServiceOptions = {}) {
    this.home = opts.home ?? homedir();
    this.claudeRoot = opts.claudeRoot ?? join(this.home, ".claude", "projects");
    this.now = opts.now ?? Date.now;
    this.git = opts.git ?? defaultGit;
  }

  /** Every checkout of the repo: workers run in linked worktrees. */
  checkouts(root: string): string[] {
    const hit = this.checkoutCache.get(root);
    if (hit && this.now() - hit.at < 10_000) return hit.list;
    const out = new Set([root]);
    const raw = this.git(["-C", root, "worktree", "list", "--porcelain", "-z"]);
    if (raw) for (const field of raw.split("\0")) if (field.startsWith("worktree ")) out.add(field.slice(9));
    const list = [...out].filter((p) => isDir(p));
    this.checkoutCache.set(root, { at: this.now(), list });
    return list;
  }

  head(checkout: string): string | null {
    const hit = this.headCache.get(checkout);
    if (hit && this.now() - hit.at < 5_000) return hit.sha;
    const sha = this.git(["-C", checkout, "rev-parse", "HEAD"])?.trim() || null;
    this.headCache.set(checkout, { at: this.now(), sha });
    return sha;
  }

  private stamp(paths: string[]): string {
    return paths.map((p) => mtimeMs(p) ?? "-").join(",");
  }

  private readLoopCached(f: LoopFile): LoopRead {
    const now = this.now();
    // Live runs read the clock (a running ticket's window ends now): re-read them each minute.
    const stamp = `${this.stamp(loopStampPaths(f))}|${Math.floor(now / 60_000)}|${this.head(f.checkout) ?? ""}`;
    return this.loopCache.get(f.path, stamp, () => readLoop(f, { now, withBlocks: false, head: (c) => this.head(c) }));
  }

  private memo = new Map<string, ListResult>();

  /** Several surfaces poll the same workspace: answer within 1.5 s from memory. */
  list(workspacePath: string, days = 30): ListResult {
    const key = `${workspacePath}\0${days}`;
    const hit = this.memo.get(key);
    if (hit && this.now() - hit.readAt < 1500) return hit;
    const result = this.read(workspacePath, days);
    this.memo.set(key, result);
    return result;
  }

  private read(workspacePath: string, days: number): ListResult {
    const now = this.now();
    const errors: string[] = [];
    const root = repoRoot(workspacePath);
    const checkouts = root ? this.checkouts(root) : [workspacePath];
    if (!root) errors.push(`${workspacePath} is not inside a git repository; reading only that folder`);
    const since = now - days * 86_400_000;

    // Loop runs: one per file name, the newest copy when several checkouts hold one.
    const loopFiles = new Map<string, LoopFile>();
    for (const f of discoverLoops(checkouts)) {
      const key = `${f.kind}:${f.kind === "autocode" ? f.checkout : basename(f.path)}`;
      const prev = loopFiles.get(key);
      if (!prev || (mtimeMs(f.path) ?? 0) > (mtimeMs(prev.path) ?? 0)) loopFiles.set(key, f);
    }
    const loops: LoopRead[] = [];
    for (const f of loopFiles.values()) {
      if ((mtimeMs(f.path) ?? 0) < since) continue;
      try {
        loops.push(this.readLoopCached(f));
        this.sources.set(f.path, { kind: "loop", file: f });
      } catch (e) {
        errors.push(`${f.path}: ${String(e)}`);
      }
    }

    // Claude runs whose session ran in a checkout, or in a worktree a loop item names.
    const worktrees = new Set(loops.flatMap((l) => l.hint.items.map((i) => i.worktree).filter((w): w is string => Boolean(w))).map(encodeCwd));
    const belongs = (projectDir: string) => inCheckouts(projectDir, checkouts, this.home) || worktrees.has(projectDir);
    const claude: WorkflowRead[] = [];
    for (const raw of discoverWorkflows(this.claudeRoot)) {
      if (raw.mtime < since || !belongs(raw.projectDir)) continue;
      claude.push(this.workflowCache.get(`wf:${raw.sessionDir}/${raw.runId}`, workflowStamp(raw, now), () => readWorkflow(raw, { now, withBlocks: false })));
      this.sources.set(raw.runId, { kind: "workflow", raw });
    }
    for (const raw of discoverSessions(this.claudeRoot)) {
      if (raw.mtime < since || !belongs(raw.projectDir)) continue;
      claude.push(this.workflowCache.get(`s:${raw.sessionDir}`, sessionStamp(raw, now), () => readSession(raw, { now, withBlocks: false })));
      this.sources.set(raw.runId, { kind: "session", raw });
    }

    const hints: LoopHint[] = loops.map((l) => l.hint);
    const edges = linkRuns(
      claude.map((c) => c.hints),
      hints,
    );
    const runs = attach([...loops.map((l) => l.run), ...claude.map((c) => c.run)], edges);
    return { repoRoot: root, checkouts, runs, edges, errors, readAt: now };
  }

  /** Full detail (prompts, results, notes) of one listed run. */
  detail(workspacePath: string, runId: string): Run | null {
    if (!this.sources.has(runId)) this.list(workspacePath);
    const src = this.sources.get(runId);
    if (!src) return null;
    const now = this.now();
    const run =
      src.kind === "workflow"
        ? readWorkflow(src.raw, { now, withBlocks: true }).run
        : src.kind === "session"
          ? readSession(src.raw, { now, withBlocks: true }).run
          : readLoop(src.file, { now, withBlocks: true, head: (c) => this.head(c) }).run;
    // Keep the links the list computed.
    const listed = this.list(workspacePath).runs.find((r) => r.runId === runId);
    return listed ? { ...run, children: listed.children, parent: listed.parent } : run;
  }

  liveCount(workspacePath: string): number {
    return this.list(workspacePath, 3).runs.filter((r) => r.live).length;
  }
}

/** Copy the edges onto the runs as parent / children refs. */
export function attach(runs: Run[], edges: readonly Edge[]): Run[] {
  const byId = new Map(runs.map((r) => [r.runId, { ...r, children: [] as Run["children"], parent: null as Run["parent"] }]));
  for (const e of edges) {
    const parent = byId.get(e.parentRunId);
    const child = byId.get(e.childRunId);
    if (!parent || !child) continue;
    parent.children.push({ runId: e.childRunId, itemId: e.parentItemId, evidence: e.evidence, confidence: e.confidence });
    child.parent = { runId: e.parentRunId, itemId: e.parentItemId, evidence: e.evidence, confidence: e.confidence };
  }
  return [...byId.values()];
}
