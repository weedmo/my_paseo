// Parent → child edges between runs. Every edge records the evidence that made it.
//
// Rules, strongest first. A run gets at most one parent: the first rule that
// finds one wins.
//   1. explicit id       a loop item's data names the workflow runId (wf_…), the
//                        Claude session id or one of the run's agent ids
//   2. worktree match    the run's session cwd (Claude project dir name) or one
//                        of its agents' cwd equals a ticket's / hypothesis's
//                        worker.worktree
//   3. session time window  a run in the same repo that started inside an item's
//                        [startedAt, startedAt + actualMin] (inferred)
//      run time window  … else inside the loop run's own [startedAt, updated]
//                        while the run's session ran in that loop's checkout (inferred)
//   4. design → build    a matt-design spec and a matt-auto / autocode run share
//                        a slug or title, or the build run names the spec path
// Unlinked runs stay top-level; nothing is dropped.
import { relative } from "node:path";
import type { Edge, Evidence } from "../shared/model.ts";
import { encodeCwd } from "./fsutil.ts";
import type { WorkflowHints } from "./workflow.ts";

export interface LoopItemHint {
  itemId: string;
  /** Absolute worktree path, when the data names one. Free text is not a path. */
  worktree: string | null;
  /** [start, end] in ms when the item ran. */
  window: [number, number] | null;
  /** Every string in the item's data, for explicit-id search. */
  text: string;
}

export interface LoopHint {
  runId: string;
  kind: "matt-auto" | "matt-design" | "matt-log" | "autocode";
  checkout: string;
  slug: string | null;
  title: string | null;
  /** Spec file this run was built from (absolute), and spec paths it mentions. */
  specPaths: string[];
  /** For a design: the spec file(s) it wrote (absolute). */
  ownSpecPaths: string[];
  window: [number, number] | null;
  items: LoopItemHint[];
  /** Run-level text (the matt-auto .md decision log, autocode program/state) for explicit ids. */
  text: string;
}

const SLACK_MS = 60_000;

const ID_PATTERNS = {
  run: /\bwf_[0-9a-f]{8}-[0-9a-f]{3}\b/g,
  session: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
  agent: /\ba[0-9a-f]{16}\b/g,
};

const norm = (p: string) => p.replace(/\/+$/, "");

export function linkRuns(workflows: readonly WorkflowHints[], loops: readonly LoopHint[]): Edge[] {
  const edges: Edge[] = [];
  const parentOf = new Map<string, Edge>();
  const add = (e: Edge) => {
    if (e.parentRunId === e.childRunId || parentOf.has(e.childRunId)) return;
    // Refuse an edge that would close a cycle.
    for (let p = parentOf.get(e.parentRunId); p; p = parentOf.get(p.parentRunId)) if (p.parentRunId === e.childRunId) return;
    parentOf.set(e.childRunId, e);
    edges.push(e);
  };
  const edge = (parentRunId: string, parentItemId: string | null, childRunId: string, evidence: Evidence, detail: string): Edge => ({
    parentRunId,
    parentItemId,
    childRunId,
    evidence,
    confidence: evidence === "session time window" || evidence === "run time window" ? "inferred" : "certain",
    detail,
  });

  // 1. Explicit ids.
  const scan = (l: LoopHint, itemId: string | null, text: string) => ({
    loop: l,
    item: { itemId },
    runs: new Set(text.match(ID_PATTERNS.run) ?? []),
    sessions: new Set(text.match(ID_PATTERNS.session) ?? []),
    agents: new Set(text.match(ID_PATTERNS.agent) ?? []),
  });
  // Item text first (more precise), then the run's own text.
  const ids = [...loops.flatMap((l) => l.items.map((it) => scan(l, it.itemId, it.text))), ...loops.map((l) => scan(l, null, l.text))];
  for (const w of workflows) {
    for (const x of ids) {
      if (x.runs.has(w.runId)) add(edge(x.loop.runId, x.item.itemId, w.runId, "explicit id", `${x.item.itemId ?? "the run log"} names ${w.runId}`));
      else if (x.sessions.has(w.sessionId)) add(edge(x.loop.runId, x.item.itemId, w.runId, "explicit id", `${x.item.itemId ?? "the run log"} names session ${w.sessionId}`));
      else {
        const agent = w.agentIds.find((a) => x.agents.has(a));
        if (agent) add(edge(x.loop.runId, x.item.itemId, w.runId, "explicit id", `${x.item.itemId ?? "the run log"} names agent ${agent}`));
      }
    }
  }

  // 2. Worktree path.
  for (const w of workflows) {
    for (const l of loops) {
      for (const it of l.items) {
        if (!it.worktree) continue;
        const wt = norm(it.worktree);
        if (w.projectDir === encodeCwd(wt)) add(edge(l.runId, it.itemId, w.runId, "worktree match", `session ran in ${wt}`));
        else if (w.cwds.some((c) => norm(c) === wt)) add(edge(l.runId, it.itemId, w.runId, "worktree match", `an agent ran in ${wt}`));
      }
    }
  }

  // 3. Time window in the same repo (the caller only passes runs of this repo).
  for (const w of workflows) {
    if (w.start == null || parentOf.has(w.runId)) continue;
    let best: { l: LoopHint; it: LoopItemHint } | null = null;
    for (const l of loops) {
      for (const it of l.items) {
        if (!it.window) continue;
        const [s, e] = it.window;
        if (w.start < s - SLACK_MS || w.start > e + SLACK_MS) continue;
        // The latest-starting item that contains the run is the closest candidate.
        if (!best || s > best.it.window![0]) best = { l, it };
      }
    }
    if (best) {
      add(edge(best.l.runId, best.it.itemId, w.runId, "session time window", `started ${fmtOffset(w.start - best.it.window![0])} after ${best.it.itemId} began`));
      continue;
    }
    for (const l of loops) {
      if (!l.window || (l.kind !== "matt-auto" && l.kind !== "autocode")) continue;
      const [s, e] = l.window;
      if (w.start < s - SLACK_MS || w.start > e + SLACK_MS) continue;
      if (w.projectDir !== encodeCwd(norm(l.checkout))) continue;
      add(edge(l.runId, null, w.runId, "run time window", `started inside the run, in its checkout ${l.checkout}`));
      break;
    }
  }

  // 4. matt-design → the build run.
  const designs = loops.filter((l) => l.kind === "matt-design");
  for (const b of loops) {
    if (b.kind !== "matt-auto" && b.kind !== "autocode") continue;
    for (const d of designs) {
      const rels = b.specPaths.map((p) => relative(b.checkout, p));
      const spec = d.ownSpecPaths.find((p) => b.specPaths.includes(p) || rels.includes(p));
      if (spec) {
        add(edge(d.runId, null, b.runId, "spec path", `built from ${spec}`));
        break;
      }
      if (d.slug && b.slug && d.slug === b.slug) {
        add(edge(d.runId, null, b.runId, "design slug", `slug ${b.slug}`));
        break;
      }
      if (d.title && b.title && d.title === b.title) {
        add(edge(d.runId, null, b.runId, "design title", `title ${b.title}`));
        break;
      }
    }
  }
  return edges;
}

function fmtOffset(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 0) return "0s";
  return s < 120 ? `${s}s` : `${Math.round(s / 60)}m`;
}
