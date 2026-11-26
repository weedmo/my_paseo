import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { discoverLoops, readLoop, specPathsIn, worktreePath, type LoopFile } from "../server/loops.ts";
import { place, tempDir, write } from "./helpers.ts";

const NOW = Date.parse("2026-11-26T10:20:00+09:00");
const opts = (head?: string) => ({ now: NOW, withBlocks: true, head: () => head ?? null });

function repo(files: Record<string, string>, vars: Record<string, string> = {}): string {
  const root = tempDir("repo");
  write(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  for (const [dest, src] of Object.entries(files)) place(src, join(root, dest), vars);
  return root;
}

const find = (root: string, kind: LoopFile["kind"]) => discoverLoops([root]).find((f) => f.kind === kind)!;

test("matt-auto with waves: stages, wave phases with their modes, review, gates per ticket", () => {
  const root = repo({ "docs/agents/matt-auto-log/tinycalc-power-format.data.json": "loops/matt-waves.data.json" });
  const { run, hint } = readLoop(find(root, "matt-auto"), opts());
  assert.equal(run.kind, "matt-auto");
  assert.equal(run.source, "matt");
  assert.equal(run.status, "done");
  assert.equal(run.live, false);
  const titles = run.phases.map((p) => `${p.title}:${p.mode}`);
  assert.deepEqual(titles, ["Design:sequential", "W1 · parallel:parallel", "W2 · sequential:sequential", "Review:sequential"]);
  const t3 = run.agentList.find((a) => a.id === "ticket:T3")!;
  assert.equal(t3.phase, "W2 · sequential");
  assert.equal(t3.tag, "T3");
  assert.ok(t3.facts.includes("blocked by T2"));
  assert.equal(run.stats, "tickets 3/3");
  assert.deepEqual(run.errors, []);
  // "Workflow 격리 worktree" is free text, not a path.
  assert.ok(hint.items.every((i) => i.worktree === null));
});

test("matt-auto without waves: columns from blockedBy levels, windows and worktrees for linking", () => {
  const root = repo({ "docs/agents/matt-auto-log/nowave.data.json": "loops/matt-nowave.data.json" }, { WT1: "/wt/t1", WT2: "../app-t2" });
  const { run, hint } = readLoop(find(root, "matt-auto"), opts());
  assert.equal(run.status, "running");
  assert.equal(run.live, true);
  const levels = run.phases.filter((p) => p.title.startsWith("L")).map((p) => p.title);
  assert.deepEqual(levels, ["L1 · parallel", "L2 · parallel", "L3 · parallel"]);
  const phaseOf = (id: string) => run.agentList.find((a) => a.id === `ticket:${id}`)!.phase;
  assert.equal(phaseOf("T1"), "L1 · parallel");
  assert.equal(phaseOf("T4"), "L1 · parallel");
  assert.equal(phaseOf("T2"), "L2 · parallel");
  assert.equal(phaseOf("T3"), "L3 · parallel");
  const h = new Map(hint.items.map((i) => [i.itemId, i]));
  assert.equal(h.get("ticket:T1")!.worktree, "/wt/t1");
  assert.equal(h.get("ticket:T2")!.worktree, join(root, "..", "app-t2"));
  assert.equal(h.get("ticket:T3")!.worktree, null);
  const t1 = h.get("ticket:T1")!.window!;
  assert.equal(t1[1] - t1[0], 10 * 60000);
  // A running ticket's window ends now.
  assert.equal(h.get("ticket:T2")!.window![1], NOW);
  assert.ok(hint.specPaths.includes(join(root, "docs/design/nowave.md")));
  assert.match(h.get("ticket:T1")!.text, /wf_cccccccc-003/);
});

test("a cycle in blockedBy is reported as an error and every ticket is still placed", () => {
  const root = repo({ "docs/agents/matt-auto-log/cycle.data.json": "loops/matt-cycle.data.json" });
  const { run } = readLoop(find(root, "matt-auto"), opts());
  assert.ok(run.errors.some((e) => e.startsWith("Dependency cycle:")), run.errors.join("; "));
  assert.ok(run.errors.some((e) => e === "Unknown dependency: D is blocked by Z"));
  assert.equal(run.agentList.filter((a) => a.id.startsWith("ticket:")).length, 4);
});

test("matt .md log fallback (core mode): sections as items, spec path, core mode noted", () => {
  const root = repo({ "docs/agents/matt-auto-log/core-spec.md": "loops/core-log.md" });
  const f = find(root, "matt-log");
  const { run, hint } = readLoop(f, opts());
  assert.equal(run.kind, "matt-log");
  assert.equal(run.name, "Core run title");
  assert.deepEqual(run.agentList.map((a) => a.label), ["Spec", "Decisions", "Execution"]);
  assert.match(run.stats, /core mode/);
  assert.deepEqual(hint.specPaths, [join(root, "docs/design/core-spec.md")]);
  assert.match(hint.text, /wf_dddddddd-004/);
});

test("a .md log next to its .data.json is not listed twice", () => {
  const root = repo({
    "docs/agents/matt-auto-log/x.data.json": "loops/matt-nowave.data.json",
    "docs/agents/matt-auto-log/x.md": "loops/core-log.md",
  });
  const kinds = discoverLoops([root]).map((f) => f.kind);
  assert.deepEqual(kinds, ["matt-auto"]);
});

test("matt-design spec: frontmatter, decisions table, tagged build steps", () => {
  const root = repo({ "docs/design/core-spec.md": "loops/spec.md", "docs/design/notes.md": "loops/core-log.md" });
  const specs = discoverLoops([root]).filter((f) => f.kind === "matt-design");
  assert.equal(specs.length, 1, "a markdown file without spec frontmatter is not a spec");
  const { run, hint } = readLoop(specs[0], opts());
  assert.equal(run.name, "Core spec title");
  assert.equal(run.status, "confirmed");
  assert.equal(run.stats, "feature · → matt-auto · core · rev 2");
  assert.deepEqual(run.phases.map((p) => p.title), ["Decisions", "Build steps"]);
  const d1 = run.agentList.find((a) => a.id === "decision:D1")!;
  assert.equal(d1.label, "Which store?");
  assert.equal(d1.state, "done");
  const steps = run.agentList.filter((a) => a.phase === "Build steps");
  assert.deepEqual(steps.map((s) => [s.tag, s.label]), [
    ["default", "model and tests."],
    ["deep", "the linker."],
  ]);
  assert.equal(hint.slug, "core-spec");
  assert.ok(hint.ownSpecPaths.includes("docs/design/core-spec.md"));
});

test("legacy matt-design run.data.json still reads", () => {
  const root = repo({ "out/design/legacy/run.data.json": "loops/legacy-run.data.json" });
  const { run } = readLoop(find(root, "matt-design"), opts());
  assert.equal(run.kind, "matt-design");
  assert.equal(run.name, "Legacy design");
  assert.ok(run.agentList.some((a) => a.id === "ticket:T1"));
});

test("autocode: experiments in time mode, frontier, worktrees resolved, spec from program.md", () => {
  const root = repo({ ".autocode/report/autocode.data.json": "loops/autocode.data.json", ".autocode/program.md": "loops/program.md" });
  const { run, hint } = readLoop(find(root, "autocode"), { ...opts(), now: Date.parse("2026-11-26T11:00:00Z") });
  assert.equal(run.source, "autocode");
  assert.equal(run.live, true);
  assert.deepEqual(run.phases, [
    { title: "Experiments", mode: "time" },
    { title: "Frontier", mode: "sequential" },
  ]);
  const h1 = run.agentList.find((a) => a.id === "hyp:H001")!;
  assert.equal(h1.state, "done");
  assert.equal(h1.sub, "-20.0%");
  assert.equal(run.agentList.find((a) => a.id === "hyp:H003")!.phase, "Frontier");
  assert.equal(run.stats, "2/10 experiments · ms 100 → 80");
  assert.equal(hint.items.find((i) => i.itemId === "hyp:H001")!.worktree, join(root, ".autocode/worktrees/H001"));
  assert.deepEqual(hint.specPaths, [join(root, "docs/design/parser.md")]);
  assert.equal(hint.slug, "parser");
});

test("gates: qa-gate scenarios, review-gate rounds and a verdict that goes stale when HEAD moves", () => {
  const files = {
    "docs/agents/matt-auto-log/nowave.data.json": "loops/matt-nowave.data.json",
    ".review/matt-auto-nowave/round-1.json": "gates/round-1.json",
    ".review/matt-auto-nowave/triage-1.json": "gates/triage-1.json",
    ".review/matt-auto-nowave/verdict.json": "gates/verdict.json",
    ".qa/matt-auto-nowave/result.json": "gates/qa-result.json",
    ".pr-visual/matt-auto-nowave/changes.json": "gates/changes.json",
    ".pr-visual/matt-auto-nowave/changes.html": "gates/changes.json",
  };
  const root = repo(files, { WT1: "/wt/t1", WT2: "/wt/t2", REVIEWED_SHA: "a".repeat(40) });
  const f = find(root, "matt-auto");
  const fresh = readLoop(f, opts("a".repeat(40))).run;
  assert.ok(fresh.phases.some((p) => p.title === "QA gate"));
  assert.ok(fresh.phases.some((p) => p.title === "Review gate"));
  assert.ok(fresh.phases.some((p) => p.title === "PR visual"));
  const qa = fresh.agentList.filter((a) => a.phase === "QA gate");
  assert.deepEqual(qa.map((a) => [a.tag, a.state]), [
    ["S1", "done"],
    ["S2", "failed"],
    ["J1", "queued"],
  ]);
  // Transcript-like output stays plain text.
  assert.equal(qa[1].blocks[0].text, "Error: <script>alert(1)</script>");
  const round = fresh.agentList.find((a) => a.id === "review-gate:matt-auto-nowave:1")!;
  assert.equal(round.sub, "2 findings");
  assert.ok(round.facts.includes("codex gpt-6.2-sol medium"));
  const verdict = fresh.agentList.find((a) => a.id.endsWith(":verdict"))!;
  assert.equal(verdict.state, "done");
  assert.equal(verdict.stateText, "PASS");
  const stale = readLoop(f, opts("b".repeat(40))).run.agentList.find((a) => a.id.endsWith(":verdict"))!;
  assert.equal(stale.state, "stopped");
  assert.equal(stale.stateText, "stale");
  const pv = fresh.agentList.find((a) => a.phase === "PR visual")!;
  assert.equal(pv.sub, "1 points");
});

test("worktree paths: absolute, relative and home paths count; free text does not", () => {
  assert.equal(worktreePath("/a/b", "/repo"), "/a/b");
  assert.equal(worktreePath(".autocode/worktrees/H1", "/repo"), "/repo/.autocode/worktrees/H1");
  assert.equal(worktreePath("Workflow worktree (merged)", "/repo"), null);
  assert.equal(worktreePath("this-session", "/repo"), null);
  assert.deepEqual(specPathsIn("built from `docs/design/x.md` and /abs/docs/design/y.md", "/repo"), ["/repo/docs/design/x.md", "/abs/docs/design/y.md"]);
});
