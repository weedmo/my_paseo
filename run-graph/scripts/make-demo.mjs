#!/usr/bin/env node
// Builds a self-contained demo home for screenshots and manual checks:
//   <home>/demo-app                  git repo with a matt-design spec, a matt-auto board,
//                                    review-gate / qa-gate files and an autocode board
//   <home>/demo-app-t1               linked worktree, ticket T1's worker ran here
//   <home>/.claude/projects/...      Claude workflow runs: one in T1's worktree (worktree
//                                    match), one inside T2's time window (inferred), one
//                                    live run inside T3's window, one standalone run
// Run a Paseo daemon with HOME=<home> so the plugin reads this tree, never ~/.claude.
// Usage: node scripts/make-demo.mjs /tmp/rg-home
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.argv[2];
if (!home || !home.startsWith("/tmp/")) throw new Error("usage: make-demo.mjs /tmp/<dir> (must be under /tmp)");
const repo = join(home, "demo-app");
const wt = join(home, "demo-app-t1");
const now = Date.now();
const min = 60_000;
const iso = (t) => new Date(t).toISOString();
const enc = (p) => p.replace(/[^A-Za-z0-9]/g, "-");
const put = (path, data, mtime) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data, null, 1));
  if (mtime) utimesSync(path, mtime / 1000, mtime / 1000);
};
const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });

rmSync(repo, { recursive: true, force: true });
rmSync(wt, { recursive: true, force: true });
rmSync(join(home, ".claude"), { recursive: true, force: true });
mkdirSync(repo, { recursive: true });
git("init", "-q", "-b", "main");
put(join(repo, "README.md"), "# demo app\n");
git("add", ".");
git("-c", "user.name=demo", "-c", "user.email=demo@example.invalid", "commit", "-qm", "init");
git("worktree", "add", "-q", "-b", "matt-auto/t1", wt);

put(
  join(repo, "docs/design/search-index.md"),
  `---
matt-design: 1
slug: search-index
revision: 2
kind: feature
loop: matt-auto
mode: full
status: confirmed
artifact: none
---
# Search index for notes

## 큰 틀

Notes get a full-text index so search answers in under 50 ms.

## 결정

| ID | 질문 | 선택 | 근거 |
|---|---|---|---|
| D1 | Index engine | SQLite FTS5 | already a dependency |
| D2 | When to index | on save, in a worker | keeps typing fast |
| D3 | Ranking | bm25 + recency | users search recent notes |

## 수용 기준

1. search returns in under 50 ms on 10k notes
2. typecheck and tests pass

## 구현 순서

1. [default] schema and migration. 확인: \`npm test\`.
2. [default] indexer worker.
3. [deep] ranking and query parser.

## 확인

Confirmed by the user.
`,
);

const board = {
  title: "Search index for notes",
  slug: "search-index",
  generated: iso(now).slice(0, 10),
  summary: "Builds the notes full-text index from the confirmed spec.",
  progress: { state: "running", updated: iso(now), startedAt: iso(now - 55 * min), current: "T3 ranking: worker running, review next" },
  stages: [
    { id: "design", name: "Design", status: "done", note: "spec docs/design/search-index.md revision 2", decisions: [{ id: "D1", question: "Index engine", decision: "SQLite FTS5" }] },
    { id: "tickets", name: "Tickets", status: "done", decisions: [] },
  ],
  plan: {
    concurrency: 2,
    placement: "local",
    waves: [
      { id: "W1", mode: "parallel", why: "independent", tickets: ["T1", "T2"] },
      { id: "W2", mode: "sequential", why: "needs both", tickets: ["T3"] },
    ],
  },
  tickets: [
    { id: "T1", title: "schema and migration", status: "done", blockedBy: [], gates: { met: 2, total: 2 }, route: "matt-default", worker: { model: "opus", effort: "medium", worktree: wt }, estimateMin: 15, startedAt: iso(now - 50 * min), actualMin: 18 },
    { id: "T2", title: "indexer worker", status: "done", blockedBy: [], gates: { met: 3, total: 3 }, route: "matt-default", worker: { model: "opus", effort: "medium", worktree: "Workflow isolated worktree" }, estimateMin: 20, startedAt: iso(now - 45 * min), actualMin: 25 },
    { id: "T3", title: "ranking and query parser", status: "in-progress", blockedBy: ["T1", "T2"], gates: { met: 1, total: 4 }, route: "matt-deep", worker: { model: "opus", effort: "high", worktree: "this session" }, estimateMin: 30, startedAt: iso(now - 15 * min) },
  ],
  review: { status: "in-progress", skill: "review-gate", passes: [{ id: "R1", name: "Codex review", status: "pending", reviewer: "codex", cross_model: true }] },
};
put(join(repo, "docs/agents/matt-auto-log/search-index.data.json"), board);
put(join(repo, "docs/agents/matt-auto-log/search-index.md"), "# matt-auto log: Search index for notes\n\n## Spec\nspec docs/design/search-index.md revision 2, mode: full\n");

const unit = "matt-auto-search-index";
put(join(repo, ".qa", unit, "result.json"), {
  surface: "cli",
  ran_at: iso(now - 20 * min),
  status: "FAIL",
  line: "1/2 passed",
  scenarios: [
    { id: "S1", acceptance: "search answers in under 50 ms", exit: 0, duration_ms: 4200, output: "p95 31 ms" },
    { id: "S2", acceptance: "recent notes rank first", exit: 1, duration_ms: 900, output: "expected note-17 first, got note-2" },
  ],
  judged: [],
});
put(join(repo, ".review", unit, "round-1.json"), {
  round: 1,
  reviewers: [{ family: "codex", model: "gpt-6.2-sol", effort: "medium" }],
  findings: [{ id: "f-1", file: "src/rank.ts", line: 40, axis: "correctness", severity: "major", claim: "recency weight ignores timezone", evidence: "Date.now() vs stored UTC" }],
});
put(join(repo, ".review", unit, "verdict.json"), { status: "CONTINUE", reviewed_sha: "0".repeat(40), rounds: 1, max_cycles: 2, writer: "claude", cross_model: true, counts: { blocker: 0, major: 1, minor: 0 }, open: ["f-1"], minor: [], reasons: ["1 open major"] });

put(join(repo, ".autocode/report/autocode.data.json"), {
  title: "Faster note search",
  slug: "autocode",
  generated: iso(now).slice(0, 10),
  summary: "Tries query-time optimizations.",
  progress: { state: "done", updated: iso(now - 26 * 3600_000), startedAt: iso(now - 30 * 3600_000) },
  run: { metric: { name: "p95 ms", direction: "lower", baseline: 48, best: 31 }, budget: { done: 3, max: 3 }, terminatedReason: "budget_exhausted" },
  hypotheses: [
    { id: "H001", seq: 1, claim: "prepared statements", status: "keep", delta: -22.9, metric: 37, startedAt: iso(now - 29 * 3600_000), measuredAt: iso(now - 28.5 * 3600_000), worker: { worktree: ".autocode/worktrees/H001" } },
    { id: "H002", seq: 2, claim: "prefix index", status: "keep", delta: -16.2, metric: 31, startedAt: iso(now - 29 * 3600_000), measuredAt: iso(now - 28 * 3600_000), worker: { worktree: ".autocode/worktrees/H002" } },
    { id: "H003", seq: 3, claim: "mmap reads", status: "discard", delta: 1.1, startedAt: iso(now - 28 * 3600_000), measuredAt: iso(now - 27.5 * 3600_000), worker: { worktree: ".autocode/worktrees/H003" } },
  ],
});
put(join(repo, ".autocode/program.md"), "# autocode program\nspec: null\n");

// ---- Claude workflow runs
const projects = join(home, ".claude", "projects");
let n = 0;
function finalRun(cwd, name, start, phases, agents) {
  n += 1;
  const session = `0000000${n}-aaaa-4bbb-8ccc-00000000000${n}`;
  const runId = `wf_${String(n).repeat(8)}-${String(n).repeat(3)}`;
  const dir = join(projects, enc(cwd), session);
  put(join(dir, "..", `${session}.jsonl`), JSON.stringify({ type: "user", cwd, sessionId: session, timestamp: iso(start) }) + "\n", start);
  let t = start;
  const progress = phases.map((title, i) => ({ type: "workflow_phase", index: i + 1, title }));
  agents.forEach(([label, phase, minutes, state], i) => {
    progress.push({ type: "workflow_agent", index: i, agentId: `a${String(n)}${String(i).padStart(15, "0")}`, label, phaseTitle: phase, state: state ?? "completed", startedAt: t, durationMs: minutes * min, tokens: 20000 + i * 7000, toolCalls: 10 + i, model: "claude-opus-5-5", promptPreview: `Task for ${label}`, resultPreview: `Done: ${label}` });
    t += (minutes * min) / 2;
  });
  const end = Math.max(...progress.filter((p) => p.startedAt).map((p) => p.startedAt + p.durationMs));
  put(join(dir, "workflows", `${runId}.json`), { runId, workflowName: name, status: "completed", startTime: start, durationMs: end - start, totalTokens: 90000, totalToolCalls: 40, summary: name, phases: phases.map((title) => ({ title })), workflowProgress: progress }, end);
  put(join(dir, "workflows", "scripts", `${name}-${runId}.js`), `export const meta = {\n  name: '${name}',\n  phases: [${phases.map((p) => `{ title: '${p}' }`).join(", ")}],\n}\n`, start);
  return runId;
}
finalRun(wt, "t1-migration", now - 48 * min, ["Write", "Verify"], [["impl:schema", "Write", 6], ["impl:migration", "Write", 8], ["check:tests", "Verify", 3]]);
finalRun(repo, "t2-indexer", now - 40 * min, ["Build", "Verify"], [["impl:worker", "Build", 10], ["impl:queue", "Build", 7], ["check:bench", "Verify", 4]]);
finalRun(repo, "explore-codebase", now - 3 * 3600_000, ["Map"], [["map:storage", "Map", 5], ["map:ui", "Map", 6]]);

// A live run inside T3's window: script and agent transcripts, no final record.
{
  const session = "00000009-aaaa-4bbb-8ccc-000000000009";
  const runId = "wf_99999999-999";
  const dir = join(projects, enc(repo), session);
  const start = now - 10 * min;
  put(join(dir, "..", `${session}.jsonl`), JSON.stringify({ type: "user", cwd: repo, sessionId: session, timestamp: iso(start) }) + "\n", start);
  put(join(dir, "workflows", "scripts", `t3-ranking-${runId}.js`), "export const meta = {\n  name: 't3-ranking',\n  phases: [{ title: 'Explore' }, { title: 'Write' }, { title: 'Verify' }],\n}\n", start);
  const agents = join(dir, "subagents", "workflows", runId);
  const agent = (id, label, phase, startAt, done) => {
    put(join(agents, `agent-${id}.meta.json`), { description: label, workflowPhase: phase, pickedEffortModel: "claude-opus-5-5" });
    const lines = [
      { type: "user", agentId: id, timestamp: iso(startAt), cwd: repo, sessionId: session, message: { role: "user", content: `Ranking task: ${label}` } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: done ? "Read" : "Edit", input: {} }] } },
    ];
    if (done) lines.push({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: `Finished ${label}` }] } });
    put(join(agents, `agent-${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", done ? startAt + 4 * min : now);
  };
  agent("a9000000000000001", "explore:bm25 options", "Explore", start, true);
  agent("a9000000000000002", "explore:recency signals", "Explore", start + 30_000, true);
  agent("a9000000000000003", "write:rank.ts", "Write", start + 5 * min, false);
}
console.log(JSON.stringify({ repo, worktree: wt, claudeRoot: projects }));
