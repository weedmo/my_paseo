import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { discoverWorkflows, inCheckouts, readWorkflow, STALE_MS } from "../server/workflow.ts";
import { encodeCwd } from "../server/fsutil.ts";
import { place, placeDir, tempDir } from "./helpers.ts";

const SESSION = "11111111-2222-3333-4444-555555555555";

function claudeRoot(opts: { liveMtime: number; worktree: string }) {
  const root = tempDir("claude");
  const project = join(root, encodeCwd("/repo/app"));
  const s = join(project, SESSION);
  place("claude/final/wf_aaaaaaaa-001.json", join(s, "workflows", "wf_aaaaaaaa-001.json"));
  place("claude/final/build-feature-wf_aaaaaaaa-001.js", join(s, "workflows", "scripts", "build-feature-wf_aaaaaaaa-001.js"));
  place("claude/live/live-run-wf_bbbbbbbb-002.js", join(s, "workflows", "scripts", "live-run-wf_bbbbbbbb-002.js"), {}, opts.liveMtime);
  placeDir("claude/live", join(s, "subagents", "workflows", "wf_bbbbbbbb-002"), { WORKTREE: opts.worktree, SESSION }, opts.liveMtime);
  return root;
}

test("workflow final record: phases, agents, tags, retries, failed state", () => {
  const now = Date.now();
  const root = claudeRoot({ liveMtime: now, worktree: "/repo/app-wt" });
  const raw = discoverWorkflows(root).find((r) => r.runId === "wf_aaaaaaaa-001");
  assert.ok(raw);
  const { run, hints } = readWorkflow(raw, { now, withBlocks: true });
  assert.equal(run.name, "build-feature");
  assert.equal(run.status, "completed");
  assert.equal(run.live, false);
  assert.deepEqual(run.phases, [
    { title: "Build", mode: "time" },
    { title: "Verify", mode: "time" },
  ]);
  assert.equal(run.agentList.length, 3);
  const [model, view, review] = run.agentList;
  assert.equal(model.tag, "impl");
  assert.equal(model.label, "model");
  assert.equal(model.end, model.start! + 200000);
  assert.deepEqual(model.blocks.map((b) => b.title), ["prompt", "result"]);
  assert.equal(view.stateText, "↻2");
  assert.equal(review.state, "failed");
  assert.equal(hints.sessionId, SESSION);
  assert.equal(hints.projectDir, encodeCwd("/repo/app"));
  assert.ok(hints.agentIds.includes("a1111111111111111"));
});

test("workflow live run: agent state from transcripts, prompt after the harness preamble", () => {
  const now = Date.now();
  const root = claudeRoot({ liveMtime: now - 10_000, worktree: "/repo/app-wt" });
  const raw = discoverWorkflows(root).find((r) => r.runId === "wf_bbbbbbbb-002")!;
  const { run, hints } = readWorkflow(raw, { now, withBlocks: true });
  assert.equal(run.status, "running");
  assert.equal(run.live, true);
  assert.equal(run.name, "live-run");
  const byId = new Map(run.agentList.map((a) => [a.id, a]));
  assert.equal(byId.get("a4444444444444444")!.state, "done");
  assert.equal(byId.get("a5555555555555555")!.state, "running");
  assert.ok(byId.get("a5555555555555555")!.facts.includes("last: Read"));
  const prompt = byId.get("a4444444444444444")!.blocks.find((b) => b.title === "prompt")!;
  assert.equal(prompt.text, "Do the task explore:map");
  const result = byId.get("a4444444444444444")!.blocks.find((b) => b.title === "result")!;
  assert.equal(result.text, "Finished explore:map");
  assert.deepEqual(hints.cwds, ["/repo/app-wt"]);
});

test("workflow stale run: no final record and no write for 180 s is stopped", () => {
  const now = Date.now();
  const root = claudeRoot({ liveMtime: now - STALE_MS - 5_000, worktree: "/repo/app-wt" });
  const raw = discoverWorkflows(root).find((r) => r.runId === "wf_bbbbbbbb-002")!;
  const { run } = readWorkflow(raw, { now, withBlocks: false });
  assert.equal(run.status, "stopped");
  assert.equal(run.live, false);
  const running = run.agentList.filter((a) => a.state === "running");
  assert.equal(running.length, 0);
  assert.ok(run.agentList.some((a) => a.state === "stopped"));
  assert.ok(run.agentList.every((a) => a.blocks.length === 0), "list payloads carry no blocks");
});

test("a run belongs to a checkout or a folder below it, never to the home dir prefix", () => {
  const checkouts = ["/repo/app", "/home/u"];
  assert.equal(inCheckouts(encodeCwd("/repo/app"), checkouts, "/home/u"), true);
  assert.equal(inCheckouts(encodeCwd("/repo/app/sub"), checkouts, "/home/u"), true);
  assert.equal(inCheckouts(encodeCwd("/repo/apple"), checkouts, "/home/u"), false);
  assert.equal(inCheckouts(encodeCwd("/home/u/other"), checkouts, "/home/u"), false);
  assert.equal(inCheckouts(encodeCwd("/home/u"), checkouts, "/home/u"), true);
});
