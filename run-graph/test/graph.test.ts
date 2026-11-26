import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { discoverLoops, readLoop } from "../server/loops.ts";
import { buildGraph, indexEdges, topLevel } from "../shared/graph.ts";
import { layoutLanes } from "../shared/lanes.ts";
import type { Edge, Item, Phase, Run } from "../shared/model.ts";
import { place, tempDir } from "./helpers.ts";

const it = (id: string, phase: string, start: number | null = null, end: number | null = null, state: Item["state"] = "done"): Item => ({
  id,
  label: id,
  tag: null,
  phase,
  state,
  start,
  end,
  sub: "",
  stateText: null,
  facts: [],
  blocks: [],
});

const run = (runId: string, phases: Phase[], items: Item[], p: Partial<Run> = {}): Run => ({
  runId,
  source: "workflow",
  kind: "workflow",
  name: runId,
  status: "completed",
  live: false,
  start: null,
  mtime: 0,
  location: "",
  stats: "",
  current: null,
  phases,
  agentList: items,
  errors: [],
  facts: [],
  children: [],
  parent: null,
  ...p,
});

const graph = (r: Run, others: Run[] = [], edges: Edge[] = [], expanded: string[] = []) =>
  buildGraph(r, new Map([r, ...others].map((x) => [x.runId, x])), indexEdges(edges), new Set(expanded));
const parentsOf = (g: ReturnType<typeof graph>, hash: string) => g.nodes.find((n) => n.hash === hash)!.parents;
const laneOf = (g: ReturnType<typeof graph>, hash: string) => g.rows[g.nodes.findIndex((n) => n.hash === hash)].lane;

test("time mode: lanes follow real overlap, a lane is reused once its item ended", () => {
  const r = run("R", [{ title: "P", mode: "time" }], [it("a", "P", 0, 10), it("b", "P", 5, 20), it("c", "P", 12, 30)]);
  const g = graph(r);
  assert.deepEqual(parentsOf(g, "R|a"), ["R|phase:0"]);
  assert.deepEqual(parentsOf(g, "R|b"), ["R|phase:0"]);
  assert.deepEqual(parentsOf(g, "R|c"), ["R|a"], "c starts after a ended: same lane");
  assert.deepEqual(parentsOf(g, "R|end"), ["R|c", "R|b"]);
  assert.equal(g.width, 2);
  assert.equal(laneOf(g, "R|a"), laneOf(g, "R|c"));
  assert.notEqual(laneOf(g, "R|a"), laneOf(g, "R|b"));
});

test("parallel mode forks every item; sequential mode chains them", () => {
  const r = run(
    "R",
    [
      { title: "W1", mode: "parallel" },
      { title: "W2", mode: "sequential" },
    ],
    [it("t1", "W1"), it("t2", "W1"), it("t3", "W1"), it("s1", "W2"), it("s2", "W2")],
  );
  const g = graph(r);
  for (const t of ["t1", "t2", "t3"]) assert.deepEqual(parentsOf(g, `R|${t}`), ["R|phase:0"]);
  assert.deepEqual(parentsOf(g, "R|phase:1"), ["R|t1", "R|t2", "R|t3"]);
  assert.deepEqual(parentsOf(g, "R|s1"), ["R|phase:1"]);
  assert.deepEqual(parentsOf(g, "R|s2"), ["R|s1"]);
  assert.equal(g.width, 3);
});

test("a planned phase without items shows only while the run is live", () => {
  const phases: Phase[] = [
    { title: "A", mode: "time" },
    { title: "B", mode: "time" },
  ];
  assert.equal(graph(run("R", phases, [it("a", "A")])).nodes.filter((n) => n.kind === "phase").length, 1);
  const live = graph(run("R", phases, [it("a", "A", 0, null, "running")], { live: true, status: "running" }));
  const b = live.nodes.find((n) => n.kind === "phase" && n.title === "B")!;
  assert.equal(b.pending, true);
  assert.equal(live.nodes.some((n) => n.kind === "end"), false);
});

const parent = run("M", [{ title: "W1", mode: "parallel" }, { title: "Review", mode: "sequential" }], [it("ticket:T1", "W1"), it("ticket:T2", "W1"), it("review:1", "Review")], {
  source: "matt",
  kind: "matt-auto",
});
const child = run("wf_1", [{ title: "Build", mode: "time" }], [it("x1", "Build", 0, 5), it("x2", "Build", 6, 9)]);
const inferredChild = run("wf_2", [{ title: "Probe", mode: "time" }], [it("y1", "Probe", 0, 5)]);
const edges: Edge[] = [
  { parentRunId: "M", parentItemId: "ticket:T1", childRunId: "wf_1", evidence: "worktree match", confidence: "certain", detail: "" },
  { parentRunId: "M", parentItemId: "ticket:T2", childRunId: "wf_2", evidence: "session time window", confidence: "inferred", detail: "" },
];

test("child sub-graph collapsed by default: a badge on the parent item, no child nodes", () => {
  const g = graph(parent, [child, inferredChild], edges);
  const t1 = g.nodes.find((n) => n.hash === "M|ticket:T1")!;
  assert.equal(t1.childCount, 1);
  assert.equal(t1.expanded, false);
  assert.equal(g.nodes.some((n) => n.runId === "wf_1"), false);
});

test("child sub-graph expanded: forks from the item, merges back into what follows it", () => {
  const g = graph(parent, [child, inferredChild], edges, ["M|ticket:T1", "M|ticket:T2"]);
  const p = "M|ticket:T1>wf_1|";
  const start = g.nodes.find((n) => n.hash === `${p}start`)!;
  assert.deepEqual(start.parents, ["M|ticket:T1"]);
  assert.equal(start.depth, 1);
  assert.equal(start.edge?.evidence, "worktree match");
  assert.equal(start.dashed, false);
  // Nodes of the child come right after the parent item.
  const i = g.nodes.findIndex((n) => n.hash === "M|ticket:T1");
  assert.equal(g.nodes[i + 1].hash, `${p}start`);
  // The next phase merges the ticket, its sibling and the child's end.
  assert.deepEqual(parentsOf(g, "M|phase:1"), ["M|ticket:T1", "M|ticket:T2", `${p}end`, "M|ticket:T2>wf_2|end"]);
  // The inferred link draws its fork dashed.
  const inferred = g.nodes.find((n) => n.hash === "M|ticket:T2>wf_2|start")!;
  assert.equal(inferred.dashed, true);
  assert.equal(inferred.edge?.confidence, "inferred");
  // The fork row carries a dashed segment.
  const row = g.rows[g.nodes.indexOf(inferred)];
  assert.ok(row.segments.some((s) => s[5]));
  assert.ok(g.width >= 3);
});

test("run-level children (design → build) hang off the parent's end", () => {
  const design = run("D", [{ title: "Decisions", mode: "sequential" }], [it("decision:D1", "Decisions")], { kind: "matt-design", source: "matt" });
  const e: Edge = { parentRunId: "D", parentItemId: null, childRunId: "M", evidence: "spec path", confidence: "certain", detail: "" };
  const collapsed = graph(design, [parent], [e]);
  assert.equal(collapsed.nodes.find((n) => n.hash === "D|end")!.childCount, 1);
  const open = graph(design, [parent], [e], ["D|end"]);
  assert.deepEqual(parentsOf(open, "D|end>M|start"), ["D|end"]);
});

test("cyclic links never loop the layout", () => {
  const a = run("A", [{ title: "P", mode: "time" }], [it("i", "P")]);
  const b = run("B", [{ title: "P", mode: "time" }], [it("j", "P")]);
  const cyc: Edge[] = [
    { parentRunId: "A", parentItemId: "i", childRunId: "B", evidence: "explicit id", confidence: "certain", detail: "" },
    { parentRunId: "B", parentItemId: "j", childRunId: "A", evidence: "explicit id", confidence: "certain", detail: "" },
  ];
  const g = graph(a, [b], cyc, ["A|i", "A|i>B|j"]);
  assert.equal(g.nodes.filter((n) => n.runId === "A" && n.kind === "start").length, 1);
});

test("a cycle in blockedBy is reported as an error, not a hang, and still lays out", () => {
  const root = tempDir("cycle");
  place("loops/matt-cycle.data.json", join(root, "docs/agents/matt-auto-log/cycle.data.json"));
  const f = discoverLoops([root])[0];
  const { run: r } = readLoop(f, { now: Date.now(), withBlocks: false });
  assert.ok(r.errors.some((e) => e.startsWith("Dependency cycle")));
  const g = graph(r);
  assert.equal(g.nodes.filter((n) => n.kind === "item").length, 4);
  assert.equal(g.rows.length, g.nodes.length);
});

test("filters: source, live only and age keep top-level runs; children of hidden parents surface", () => {
  const m = { ...parent, mtime: 100 };
  const w1 = { ...child, mtime: 200, live: true };
  const w2 = { ...inferredChild, mtime: 50 };
  const all = topLevel([m, w1, w2], edges);
  assert.deepEqual(all.map((r) => r.runId), ["M"]);
  const wfOnly = topLevel([m, w1, w2], edges, { sources: new Set(["workflow"]) });
  assert.deepEqual(wfOnly.map((r) => r.runId), ["wf_1", "wf_2"]);
  assert.deepEqual(topLevel([m, w1, w2], edges, { liveOnly: true }).map((r) => r.runId), ["wf_1"]);
  assert.deepEqual(topLevel([m, w1, w2], edges, { since: 150, sources: new Set(["workflow", "matt"]) }).map((r) => r.runId), ["wf_1"]);
});

test("lanes: a branch keeps its column until its parent arrives", () => {
  const { rows, width } = layoutLanes([
    { hash: "m", parents: ["a", "b"] },
    { hash: "b", parents: ["r"] },
    { hash: "a", parents: ["r"] },
    { hash: "r", parents: [] },
  ]);
  assert.equal(width, 2);
  assert.deepEqual(
    rows.map((r) => r.lane),
    [0, 1, 0, 0],
  );
});
