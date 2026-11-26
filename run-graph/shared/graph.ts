// Turns normalized runs and their links into git-graph "commits" laid out on lanes.
// Ported from the workflow-graph mod (model.js) and extended with child runs.
//
//   start ─▶ phase ─▶ items on lanes ─▶ next phase (merge) ─▶ … ─▶ end
//
// A child run (a workflow a ticket's worker started, a matt-auto run built from
// a matt-design spec, ...) is a sub-graph that forks from its parent item's
// node and merges back into whatever follows that item. Child runs are
// collapsed by default: the parent item shows an "n runs" badge, and its node
// key goes into `expanded` to open it. An inferred link draws its fork dashed.
import { layoutLanes, type LaneRow } from "./lanes.ts";
import type { Edge, Item, Run } from "./model.ts";

export type NodeKind = "start" | "phase" | "item" | "end";

export interface GraphNode {
  hash: string;
  parents: string[];
  kind: NodeKind;
  runId: string;
  depth: number;
  title: string;
  item?: Item;
  dashed: boolean;
  /** On a child run's start node: the link that put it here. */
  edge?: Edge;
  /** Child runs hanging off this node, and whether they are shown. */
  childCount: number;
  /** How many of those child runs (or their descendants) are live. */
  childLive: number;
  expanded: boolean;
  /** Phase counters. */
  count?: number;
  done?: number;
  running?: number;
  pending?: boolean;
}

export interface Graph {
  runId: string;
  nodes: GraphNode[];
  rows: LaneRow[];
  width: number;
}

export const edgeKey = (runId: string, itemId: string | null) => `${runId}\u0000${itemId ?? ""}`;

export function indexEdges(edges: readonly Edge[]): Map<string, Edge[]> {
  const out = new Map<string, Edge[]>();
  for (const e of edges) {
    const k = edgeKey(e.parentRunId, e.parentItemId);
    const list = out.get(k);
    if (list) list.push(e);
    else out.set(k, [e]);
  }
  return out;
}

interface Ctx {
  runs: ReadonlyMap<string, Run>;
  byParent: ReadonlyMap<string, Edge[]>;
  expanded: ReadonlySet<string>;
  nodes: GraphNode[];
  merges: Map<string, string[]>;
}

function emitRun(ctx: Ctx, run: Run, prefix: string, depth: number, forkFrom: string | null, edge: Edge | null, path: ReadonlySet<string>): string[] {
  const seen = new Set(path).add(run.runId);
  const items = run.agentList;
  const phases = run.phases.map((p) => ({ ...p }));
  for (const a of items) if (!phases.some((p) => p.title === a.phase)) phases.push({ title: a.phase, mode: "time" });
  const live = run.live;
  const node = (n: Omit<GraphNode, "runId" | "depth" | "childCount" | "childLive" | "expanded" | "dashed"> & Partial<GraphNode>): GraphNode => {
    const full: GraphNode = { runId: run.runId, depth, childCount: 0, childLive: 0, expanded: false, dashed: false, ...n };
    ctx.nodes.push(full);
    return full;
  };
  const start = prefix + "start";
  node({
    hash: start,
    parents: forkFrom ? [forkFrom] : [],
    kind: "start",
    title: run.name,
    dashed: edge?.confidence === "inferred",
    edge: edge ?? undefined,
  });

  // Child runs of one node: shown right after it when expanded.
  const children = (hash: string, itemId: string | null, target: GraphNode, merge: boolean) => {
    const edges = (ctx.byParent.get(edgeKey(run.runId, itemId)) ?? []).filter((e) => ctx.runs.has(e.childRunId) && !seen.has(e.childRunId));
    target.childCount = edges.length;
    target.childLive = edges.filter((e) => liveBelow(ctx.runs, ctx.byParent, e.childRunId, new Set())).length;
    if (!edges.length || !ctx.expanded.has(hash)) return;
    target.expanded = true;
    for (const e of edges) {
      const child = ctx.runs.get(e.childRunId)!;
      const tails = emitRun(ctx, child, `${hash}>${child.runId}|`, depth + 1, hash, e, seen);
      if (merge && tails.length) ctx.merges.set(hash, [...(ctx.merges.get(hash) ?? []), ...tails]);
    }
  };

  let tails = [start];
  phases.forEach((phase, i) => {
    const list = items.filter((a) => a.phase === phase.title);
    // A planned phase not reached yet shows only while the run is going.
    if (!list.length && !live) return;
    const ph = `${prefix}phase:${i}`;
    node({
      hash: ph,
      parents: tails,
      kind: "phase",
      title: phase.title || "(no phase)",
      count: list.length,
      pending: !list.length,
      done: list.filter((a) => a.state === "done").length,
      running: list.filter((a) => a.state === "running").length,
    });
    let slots: { end?: number; hash: string }[] = [];
    for (const a of list) {
      const hash = prefix + a.id;
      let parent: string;
      if (phase.mode === "parallel") {
        parent = ph;
        slots.push({ hash });
      } else if (phase.mode === "sequential") {
        parent = slots[0]?.hash ?? ph;
        slots = [{ hash }];
      } else {
        const s0 = a.start ?? Infinity;
        const end = a.end ?? Infinity;
        const s = slots.findIndex((x) => (x.end ?? Infinity) <= s0);
        parent = s < 0 ? ph : slots[s].hash;
        if (s < 0) slots.push({ end, hash });
        else slots[s] = { end, hash };
      }
      const n = node({
        hash,
        parents: [parent],
        kind: "item",
        title: a.label,
        item: a,
        dashed: a.state === "running" || a.state === "queued",
      });
      children(hash, a.id, n, true);
    }
    tails = slots.length ? slots.map((x) => x.hash) : [ph];
  });
  let out: string[] = [];
  let anchor: GraphNode;
  if (!live) {
    anchor = node({ hash: prefix + "end", parents: tails, kind: "end", title: run.status });
    out = [anchor.hash];
  } else {
    anchor = ctx.nodes.find((n) => n.hash === start)!;
  }
  // Run-level children (a matt-auto run built from this design) hang off the end.
  children(anchor.hash, null, anchor, false);
  return out;
}

/** The run, or any run linked below it, is live. */
export function liveBelow(runs: ReadonlyMap<string, Run>, byParent: ReadonlyMap<string, Edge[]>, runId: string, seen: Set<string>): boolean {
  if (seen.has(runId)) return false;
  seen.add(runId);
  const run = runs.get(runId);
  if (!run) return false;
  if (run.live) return true;
  for (const [key, edges] of byParent) {
    if (!key.startsWith(`${runId}\u0000`)) continue;
    if (edges.some((e) => liveBelow(runs, byParent, e.childRunId, seen))) return true;
  }
  return false;
}

export function buildGraph(run: Run, runs: ReadonlyMap<string, Run>, byParent: ReadonlyMap<string, Edge[]>, expanded: ReadonlySet<string>): Graph {
  const ctx: Ctx = { runs, byParent, expanded, nodes: [], merges: new Map() };
  emitRun(ctx, run, `${run.runId}|`, 0, null, null, new Set());
  // Merge each expanded child back into the first node that follows its parent item.
  for (const n of ctx.nodes) {
    for (const p of [...n.parents]) {
      const tails = ctx.merges.get(p);
      // The child's own start also points at the item: merge into the first node outside it.
      if (!tails || n.hash.startsWith(`${p}>`)) continue;
      n.parents.push(...tails);
      ctx.merges.delete(p);
    }
  }
  const { rows, width } = layoutLanes(ctx.nodes.slice().reverse());
  const flipped = rows.reverse().map((r) => ({
    lane: r.lane,
    segments: r.segments.map(([a, ya, b, yb, c, d]) => [b, 1 - yb, a, 1 - ya, c, d] as LaneRow["segments"][number]),
  }));
  return { runId: run.runId, nodes: ctx.nodes, rows: flipped, width };
}

export interface ForestFilter {
  sources?: ReadonlySet<string>;
  liveOnly?: boolean;
  /** Keep runs whose files changed after this time. */
  since?: number;
}

/** The runs to draw at the top level: those with no shown parent. Never drops a run. */
export function topLevel(runs: readonly Run[], edges: readonly Edge[], filter: ForestFilter = {}): Run[] {
  const keep = (r: Run) =>
    (!filter.sources || filter.sources.has(r.source)) && (!filter.liveOnly || r.live) && (filter.since == null || r.mtime >= filter.since);
  const shown = new Set(runs.filter(keep).map((r) => r.runId));
  const hasParent = new Set(edges.filter((e) => shown.has(e.parentRunId)).map((e) => e.childRunId));
  return runs
    .filter((r) => shown.has(r.runId) && !hasParent.has(r.runId))
    .sort((a, b) => Number(b.live) - Number(a.live) || b.mtime - a.mtime);
}
