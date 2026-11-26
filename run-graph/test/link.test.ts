import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeCwd } from "../server/fsutil.ts";
import { linkRuns, type LoopHint } from "../server/link.ts";
import { attach } from "../server/service.ts";
import type { Run } from "../shared/model.ts";
import type { WorkflowHints } from "../server/workflow.ts";

const T0 = Date.parse("2026-11-26T10:00:00Z");
const MIN = 60_000;

const wf = (p: Partial<WorkflowHints> & { runId: string }): WorkflowHints => ({
  projectDir: encodeCwd("/repo/app"),
  sessionId: "00000000-0000-0000-0000-000000000000",
  cwds: [],
  agentIds: [],
  start: null,
  ...p,
});

const matt = (items: LoopHint["items"], p: Partial<LoopHint> = {}): LoopHint => ({
  runId: "/repo/app/docs/agents/matt-auto-log/x.data.json",
  kind: "matt-auto",
  checkout: "/repo/app",
  slug: "x",
  title: "X",
  specPaths: [],
  ownSpecPaths: [],
  window: null,
  items,
  text: "",
  ...p,
});

test("explicit id: a ticket that names the workflow run, its session or an agent", () => {
  const loop = matt([
    { itemId: "ticket:T1", worktree: null, window: null, text: '{"note":"ran as wf_aaaaaaaa-001"}' },
    { itemId: "ticket:T2", worktree: null, window: null, text: '{"note":"session 11111111-2222-3333-4444-555555555555"}' },
    { itemId: "ticket:T3", worktree: null, window: null, text: '{"note":"agent a1234567890abcdef"}' },
  ]);
  const edges = linkRuns(
    [
      wf({ runId: "wf_aaaaaaaa-001" }),
      wf({ runId: "wf_bbbbbbbb-002", sessionId: "11111111-2222-3333-4444-555555555555" }),
      wf({ runId: "wf_cccccccc-003", agentIds: ["a1234567890abcdef"] }),
    ],
    [loop],
  );
  assert.deepEqual(
    edges.map((e) => [e.childRunId, e.parentItemId, e.evidence, e.confidence]),
    [
      ["wf_aaaaaaaa-001", "ticket:T1", "explicit id", "certain"],
      ["wf_bbbbbbbb-002", "ticket:T2", "explicit id", "certain"],
      ["wf_cccccccc-003", "ticket:T3", "explicit id", "certain"],
    ],
  );
});

test("explicit id in the run's own log links to the run, after item matches", () => {
  const loop = matt([], { text: "## Execution\nWorkflow run wf_dddddddd-004" });
  const [e] = linkRuns([wf({ runId: "wf_dddddddd-004" })], [loop]);
  assert.equal(e.parentItemId, null);
  assert.equal(e.evidence, "explicit id");
});

test("worktree match: the session cwd or an agent cwd is the ticket's worktree", () => {
  const loop = matt([
    { itemId: "ticket:T1", worktree: "/repo/app-t1", window: null, text: "{}" },
    { itemId: "ticket:T2", worktree: "/repo/app-t2/", window: null, text: "{}" },
  ]);
  const edges = linkRuns(
    [wf({ runId: "wf_1", projectDir: encodeCwd("/repo/app-t1") }), wf({ runId: "wf_2", cwds: ["/repo/app-t2"] })],
    [loop],
  );
  assert.deepEqual(
    edges.map((e) => [e.childRunId, e.parentItemId, e.evidence, e.confidence]),
    [
      ["wf_1", "ticket:T1", "worktree match", "certain"],
      ["wf_2", "ticket:T2", "worktree match", "certain"],
    ],
  );
});

test("time window: a run that started inside a ticket's window is an inferred candidate", () => {
  const loop = matt(
    [
      { itemId: "ticket:T1", worktree: null, window: [T0, T0 + 30 * MIN], text: "{}" },
      { itemId: "ticket:T2", worktree: null, window: [T0 + 10 * MIN, T0 + 20 * MIN], text: "{}" },
    ],
    { window: [T0, T0 + 120 * MIN] },
  );
  const edges = linkRuns([wf({ runId: "wf_in", start: T0 + 12 * MIN }), wf({ runId: "wf_late", start: T0 + 90 * MIN })], [loop]);
  const byChild = new Map(edges.map((e) => [e.childRunId, e]));
  // The latest-starting item that contains the run wins.
  assert.equal(byChild.get("wf_in")!.parentItemId, "ticket:T2");
  assert.equal(byChild.get("wf_in")!.evidence, "session time window");
  assert.equal(byChild.get("wf_in")!.confidence, "inferred");
  // Outside every ticket, inside the run, in the run's checkout: a run-level inferred link.
  assert.equal(byChild.get("wf_late")!.parentItemId, null);
  assert.equal(byChild.get("wf_late")!.evidence, "run time window");
  assert.equal(byChild.get("wf_late")!.confidence, "inferred");
});

test("a stronger rule wins: a worktree match is not replaced by a time window", () => {
  const loop = matt([
    { itemId: "ticket:T1", worktree: "/wt/one", window: null, text: "{}" },
    { itemId: "ticket:T2", worktree: null, window: [T0, T0 + 60 * MIN], text: "{}" },
  ]);
  const edges = linkRuns([wf({ runId: "wf_1", projectDir: encodeCwd("/wt/one"), start: T0 + MIN })], [loop]);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].parentItemId, "ticket:T1");
});

test("unlinked runs stay top-level and are never dropped", () => {
  const loop = matt([{ itemId: "ticket:T1", worktree: "/wt/one", window: [T0, T0 + MIN], text: "{}" }]);
  const edges = linkRuns([wf({ runId: "wf_free", projectDir: encodeCwd("/elsewhere"), start: T0 + 300 * MIN })], [loop]);
  assert.deepEqual(edges, []);
  const run = (runId: string): Run => ({
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
    phases: [],
    agentList: [],
    errors: [],
    facts: [],
    children: [],
    parent: null,
  });
  const runs = attach([run(loop.runId), run("wf_free")], edges);
  assert.equal(runs.length, 2);
  assert.equal(runs.find((r) => r.runId === "wf_free")!.parent, null);
});

test("matt-design → build run by spec path, slug or title", () => {
  const design = (runId: string, slug: string, title: string): LoopHint => ({
    ...matt([], { runId, kind: "matt-design", slug, title, ownSpecPaths: [`/repo/app/docs/design/${slug}.md`, `docs/design/${slug}.md`] }),
  });
  const byPath = matt([], { runId: "auto-1", slug: "other", title: "other", specPaths: ["/repo/app-wt/docs/design/spec-a.md"], checkout: "/repo/app-wt" });
  const bySlug = matt([], { runId: "auto-2", slug: "spec-b", title: "nope" });
  const byTitle = matt([], { runId: "auto-3", kind: "autocode", slug: "metric", title: "Title C" });
  const edges = linkRuns([], [design("d-a", "spec-a", "A"), design("d-b", "spec-b", "B"), design("d-c", "spec-c", "Title C"), byPath, bySlug, byTitle]);
  assert.deepEqual(
    edges.map((e) => [e.parentRunId, e.childRunId, e.evidence, e.parentItemId]),
    [
      ["d-a", "auto-1", "spec path", null],
      ["d-b", "auto-2", "design slug", null],
      ["d-c", "auto-3", "design title", null],
    ],
  );
});

test("one parent per run and no cycles", () => {
  const a = matt([{ itemId: "i", worktree: null, window: null, text: "wf_aaaaaaaa-001" }], { runId: "A" });
  const b = matt([{ itemId: "j", worktree: null, window: null, text: "wf_aaaaaaaa-001" }], { runId: "B" });
  const edges = linkRuns([wf({ runId: "wf_aaaaaaaa-001" })], [a, b]);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].parentRunId, "A");
});
