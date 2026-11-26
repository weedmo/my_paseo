// Claude Code workflow runs, ported from the Herdr workflow-graph mod (reader.py).
//
// Under <claudeRoot>/<project>/<session>/:
//   workflows/wf_<id>.json                         final record, written when a run ends
//   workflows/scripts/<name>-wf_<id>.js            the script (meta.phases), written at launch
//   subagents/workflows/wf_<id>/agent-*.jsonl      live transcripts, one per agent
//   subagents/workflows/wf_<id>/agent-*.meta.json  label (description), phase, model
// A run without its final record is live; with no write for STALE_MS it is "stopped".
import { basename, dirname, join } from "node:path";
import type { Block, Item, ItemState, Run } from "../shared/model.ts";
import {
  arr,
  clip,
  encodeCwd,
  headAndTail,
  isDir,
  isFile,
  isoMs,
  kilo,
  list,
  mtimeMs,
  num,
  obj,
  readJson,
  readText,
  str,
} from "./fsutil.ts";

export const STALE_MS = 180_000;
const DONE_MARKERS = ["Structured output provided successfully", '"stop_reason":"end_turn"'];

export interface RawWorkflowRun {
  runId: string;
  sessionDir: string;
  /** The Claude project dir name: the session cwd, encoded. */
  projectDir: string;
  sessionId: string;
  agentsDir: string | null;
  final: string | null;
  script: string | null;
  mtime: number;
}

/** What the linker needs to know about a workflow run. */
export interface WorkflowHints {
  runId: string;
  projectDir: string;
  sessionId: string;
  /** cwd values found in agent transcripts (a worker's worktree shows up here). */
  cwds: string[];
  agentIds: string[];
  start: number | null;
}

export interface WorkflowRead {
  run: Run;
  hints: WorkflowHints;
}

export function discoverWorkflows(claudeRoot: string): RawWorkflowRun[] {
  const runs = new Map<string, RawWorkflowRun>();
  for (const project of list(claudeRoot)) {
    const projectPath = join(claudeRoot, project);
    for (const session of list(projectPath)) {
      const sessionDir = join(projectPath, session);
      if (!isDir(sessionDir)) continue;
      const make = (runId: string): RawWorkflowRun => {
        let r = runs.get(runId);
        if (!r) {
          r = { runId, sessionDir, projectDir: project, sessionId: session, agentsDir: null, final: null, script: null, mtime: 0 };
          runs.set(runId, r);
        }
        return r;
      };
      const agentsRoot = join(sessionDir, "subagents", "workflows");
      for (const rid of list(agentsRoot)) if (rid.startsWith("wf_")) make(rid).agentsDir = join(agentsRoot, rid);
      const wfDir = join(sessionDir, "workflows");
      for (const f of list(wfDir)) if (f.startsWith("wf_") && f.endsWith(".json")) make(f.slice(0, -5)).final = join(wfDir, f);
    }
  }
  for (const r of runs.values()) {
    const scripts = join(r.sessionDir, "workflows", "scripts");
    const s = list(scripts).find((f) => f.endsWith(`-${r.runId}.js`));
    r.script = s ? join(scripts, s) : null;
    const paths = [r.final, r.script, r.agentsDir].filter((p): p is string => Boolean(p));
    if (r.agentsDir) for (const f of list(r.agentsDir)) if (f.endsWith(".jsonl")) paths.push(join(r.agentsDir, f));
    r.mtime = Math.max(0, ...paths.map((p) => mtimeMs(p) ?? 0));
  }
  return [...runs.values()];
}

/** A stamp that changes whenever any file of the run changes. */
export function workflowStamp(r: RawWorkflowRun, now: number): string {
  const stale = !r.final && now - r.mtime >= STALE_MS;
  return `${r.mtime}:${r.final ? 1 : 0}:${stale ? 1 : 0}`;
}

export function scriptMeta(path: string | null): { name: string | null; phases: string[] } {
  if (!path) return { name: null, phases: [] };
  const src = readText(path, 20000);
  if (!src) return { name: null, phases: [] };
  const m = /export\s+const\s+meta\s*=\s*\{([\s\S]*?)\n\}/.exec(src);
  const block = m ? m[1] : src.slice(0, 4000);
  const name = /name\s*:\s*['"`]([^'"`]+)/.exec(block);
  const p = /phases\s*:\s*\[([\s\S]*?)\]/.exec(block);
  const phases = p ? [...p[1].matchAll(/['"]?title['"]?\s*:\s*['"`]([^'"`]+)/g)].map((x) => x[1]) : [];
  return { name: name ? name[1] : null, phases };
}

export interface LiveAgent extends Item {
  lastAt: number | null;
  cwd: string | null;
}

export function liveAgent(metaPath: string, withBlocks: boolean): LiveAgent {
  const id = basename(metaPath).slice("agent-".length, -".meta.json".length);
  const meta = obj(readJson(metaPath));
  const transcript = metaPath.slice(0, -".meta.json".length) + ".jsonl";
  const a: LiveAgent = {
    id,
    label: str(meta.description) ?? id,
    tag: null,
    phase: str(meta.workflowPhase) ?? "",
    state: "queued",
    start: null,
    end: null,
    sub: "",
    stateText: null,
    facts: [],
    blocks: [],
    lastAt: null,
    cwd: null,
  };
  const model = str(meta.pickedEffortModel) ?? str(meta.model);
  if (model) a.facts.push(model);
  const type = str(meta.agentType);
  if (type && type !== "workflow-subagent") a.facts.push(type);
  if (!isFile(transcript)) return a;
  const read = headAndTail(transcript);
  if (!read) return a;
  let prompt: string | null = null;
  try {
    const head = obj(JSON.parse(read.head));
    a.start = isoMs(head.timestamp);
    a.cwd = str(head.cwd);
    const content = obj(head.message).content;
    if (typeof content === "string") {
      // The first turn relays the user's request; the computed task follows it.
      prompt = content.startsWith("[Workflow harness") ? content.split("\n\n").slice(1).join("\n\n") || content : content;
    }
  } catch {
    // A half-written first line: keep what the meta file said.
  }
  const mtime = mtimeMs(transcript);
  const done = meta.finished === true || DONE_MARKERS.some((m) => read.tail.includes(m));
  a.state = done ? "done" : "running";
  a.end = done ? mtime : null;
  a.lastAt = mtime;
  let last: string | null = null;
  let result: string | null = null;
  const lines = read.tail.split("\n").slice(1); // the first may be cut
  for (let i = lines.length - 1; i >= 0 && !last && !result; i--) {
    let o: Record<string, unknown>;
    try {
      o = obj(JSON.parse(lines[i]));
    } catch {
      continue;
    }
    const content = obj(o.message).content;
    if (o.type !== "assistant" || !Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const c = obj(content[j]);
      if (c.type === "tool_use") {
        last = str(c.name);
        break;
      }
      if (c.type === "text" && done) {
        result = str(c.text);
        break;
      }
    }
  }
  if (last) a.facts.push(`last: ${last}`);
  if (withBlocks) {
    a.blocks = blocks([
      ["prompt", prompt],
      ["result", result],
      ["transcript", transcript],
    ]);
  }
  return a;
}

const blocks = (pairs: [string, string | null | undefined][]): Block[] =>
  pairs.filter(([, t]) => Boolean(t)).map(([title, text]) => ({ title, text: clip(text as string, 2000) }));

function finalState(s: unknown): ItemState {
  switch (s) {
    case "completed":
    case "done":
      return "done";
    case "running":
      return "running";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "killed":
    case "stopped":
      return "stopped";
    default:
      return "queued";
  }
}

/** First `"cwd":"..."` in the session's own transcript: where the session ran. */
function sessionCwd(r: RawWorkflowRun): string | null {
  return sessionCwdOf(r.sessionDir, r.sessionId);
}

export function readWorkflow(r: RawWorkflowRun, opts: { now: number; withBlocks: boolean }): WorkflowRead {
  const final = r.final ? obj(readJson(r.final)) : null;
  const meta = scriptMeta(r.script);
  let phases = meta.phases;
  let name = meta.name;
  let status: string;
  let start: number | null = null;
  const facts: string[] = [];
  const agents: LiveAgent[] = [];
  const cwds = new Set<string>();
  if (final) {
    status = str(final.status) ?? "completed";
    name = str(final.workflowName) ?? name;
    start = num(final.startTime);
    const fp = arr(final.phases).map((p) => str(obj(p).title)).filter((t): t is string => Boolean(t));
    if (fp.length) phases = fp;
    for (const raw of arr(final.workflowProgress)) {
      const e = obj(raw);
      if (e.type !== "workflow_agent") continue;
      const st = num(e.startedAt);
      const dur = num(e.durationMs);
      const tokens = num(e.tokens);
      const tools = num(e.toolCalls);
      const attempt = num(e.attempt) ?? 1;
      const state = finalState(e.state);
      agents.push({
        id: str(e.agentId) ?? `i${String(e.index)}`,
        label: str(e.label) ?? "",
        tag: null,
        phase: str(e.phaseTitle) ?? "",
        state,
        start: st,
        end: st != null && dur != null ? st + dur : null,
        sub: kilo(tokens),
        stateText: state === "done" && attempt > 1 ? `↻${attempt}` : null,
        facts: [
          str(e.model),
          tokens != null ? `${tokens.toLocaleString("en-US")} tokens` : null,
          tools != null ? `${tools} tool calls` : null,
          str(e.lastToolName) ? `last: ${str(e.lastToolName)}` : null,
        ].filter((x): x is string => Boolean(x)),
        blocks: opts.withBlocks
          ? blocks([
              ["prompt", str(e.promptPreview)],
              ["result", str(e.resultPreview)],
            ])
          : [],
        lastAt: null,
        cwd: null,
      });
    }
    const dur = num(final.durationMs);
    const tok = num(final.totalTokens);
    if (dur != null) facts.push(`duration ${Math.round(dur / 1000)}s`);
    if (tok != null) facts.push(`${kilo(tok)} tokens`);
    if (num(final.totalToolCalls) != null) facts.push(`${num(final.totalToolCalls)} tool calls`);
    const summary = str(final.summary);
    if (summary) facts.push(summary);
    // Agents' transcripts still exist after the run ends: read their cwd for linking.
    if (r.agentsDir) {
      for (const f of list(r.agentsDir)) {
        if (!f.endsWith(".jsonl")) continue;
        const head = headAndTail(join(r.agentsDir, f), 0);
        try {
          const cwd = head ? str(obj(JSON.parse(head.head)).cwd) : null;
          if (cwd) cwds.add(cwd);
        } catch {
          // ignore a broken first line
        }
      }
    }
  } else {
    status = opts.now - r.mtime < STALE_MS ? "running" : "stopped";
    if (r.script) start = mtimeMs(r.script);
    if (r.agentsDir) {
      for (const f of list(r.agentsDir)) if (f.endsWith(".meta.json")) agents.push(liveAgent(join(r.agentsDir, f), opts.withBlocks));
    }
    if (status !== "running") {
      for (const a of agents) {
        if (a.state === "running") {
          a.state = "stopped";
          a.end = a.lastAt;
        }
      }
    }
    for (const a of agents) if (a.cwd) cwds.add(a.cwd);
    if (start == null) start = Math.min(...agents.map((a) => a.start ?? Infinity));
    if (!Number.isFinite(start)) start = null;
  }
  if (!name && r.script) name = basename(r.script).slice(0, -(r.runId.length + 4));
  agents.sort((a, b) => (a.start ?? Number.MAX_SAFE_INTEGER) - (b.start ?? Number.MAX_SAFE_INTEGER));
  for (const a of agents) {
    // "kind:rest" labels carry a tag, the way the mod shows them.
    const i = a.label.indexOf(":");
    if (i > 0 && i < a.label.length - 1) {
      a.tag = a.label.slice(0, i);
      a.label = a.label.slice(i + 1).trim();
    }
  }
  const done = agents.filter((a) => a.state === "done").length;
  const location = sessionCwd(r) ?? r.projectDir;
  const run: Run = {
    runId: r.runId,
    source: "workflow",
    kind: "workflow",
    name: name ?? r.runId,
    status,
    live: status === "running",
    start,
    mtime: r.mtime,
    location,
    stats: `${done}/${agents.length} agents`,
    current: null,
    phases: phases.map((title) => ({ title, mode: "time" as const })),
    agentList: agents.map(({ lastAt: _l, cwd: _c, ...item }) => item),
    errors: [],
    facts: [`session ${r.sessionId}`, ...facts],
    children: [],
    parent: null,
  };
  return {
    run,
    hints: {
      runId: r.runId,
      projectDir: r.projectDir,
      sessionId: r.sessionId,
      cwds: [...cwds],
      agentIds: agents.map((a) => a.id),
      start,
    },
  };
}

/** A workflow run belongs to a repo when its session ran in a checkout or below one. */
export function inCheckouts(projectDir: string, checkouts: readonly string[], home: string): boolean {
  const homeKey = encodeCwd(home);
  return checkouts.some((c) => {
    const key = encodeCwd(c);
    return projectDir === key || (key !== homeKey && projectDir.startsWith(`${key}-`));
  });
}

// ---- Plain subagents of a session (Agent tool, not a workflow)
//
// <claudeRoot>/<project>/<session>/subagents/agent-*.jsonl + .meta.json
// matt-auto full mode without hc runs ticket workers this way (isolation:
// "worktree"), and autocode runs its strategist and experimenters this way.
// One run per session; every subagent is an item, grouped by agent type.

export interface RawSession {
  runId: string;
  sessionDir: string;
  projectDir: string;
  sessionId: string;
  subDir: string;
  mtime: number;
}

export function discoverSessions(claudeRoot: string): RawSession[] {
  const out: RawSession[] = [];
  for (const project of list(claudeRoot)) {
    const projectPath = join(claudeRoot, project);
    for (const session of list(projectPath)) {
      const subDir = join(projectPath, session, "subagents");
      const metas = list(subDir).filter((f) => f.startsWith("agent-") && f.endsWith(".meta.json"));
      if (!metas.length) continue;
      const files = list(subDir).filter((f) => f.endsWith(".jsonl") || f.endsWith(".meta.json"));
      const mtime = Math.max(0, ...files.map((f) => mtimeMs(join(subDir, f)) ?? 0));
      out.push({ runId: `session:${session}`, sessionDir: join(projectPath, session), projectDir: project, sessionId: session, subDir, mtime });
    }
  }
  return out;
}

export function sessionStamp(r: RawSession, now: number): string {
  return `${r.mtime}:${now - r.mtime >= STALE_MS ? 1 : 0}`;
}

export function readSession(r: RawSession, opts: { now: number; withBlocks: boolean }): WorkflowRead {
  const agents = list(r.subDir)
    .filter((f) => f.startsWith("agent-") && f.endsWith(".meta.json"))
    .map((f) => {
      const meta = obj(readJson(join(r.subDir, f)));
      const a = liveAgent(join(r.subDir, f), opts.withBlocks);
      a.phase = str(meta.agentType) ?? "agent";
      return a;
    });
  const fresh = opts.now - r.mtime < STALE_MS;
  for (const a of agents) {
    if (a.state === "running" && !fresh) {
      a.state = "stopped";
      a.end = a.lastAt;
    }
  }
  agents.sort((a, b) => (a.start ?? Number.MAX_SAFE_INTEGER) - (b.start ?? Number.MAX_SAFE_INTEGER));
  const live = agents.some((a) => a.state === "running");
  const start = agents.length ? agents[0].start : null;
  const phases = [...new Set(agents.map((a) => a.phase))];
  const location = sessionCwdOf(r.sessionDir, r.sessionId) ?? r.projectDir;
  const done = agents.filter((a) => a.state === "done").length;
  const run: Run = {
    runId: r.runId,
    source: "workflow",
    kind: "session",
    name: `session ${r.sessionId.slice(0, 8)} subagents`,
    status: live ? "running" : agents.some((a) => a.state === "stopped") ? "stopped" : "completed",
    live,
    start,
    mtime: r.mtime,
    location,
    stats: `${done}/${agents.length} subagents`,
    current: null,
    phases: phases.map((title) => ({ title, mode: "time" as const })),
    agentList: agents.map(({ lastAt: _l, cwd: _c, ...item }) => item),
    errors: [],
    facts: [`session ${r.sessionId}`],
    children: [],
    parent: null,
  };
  return {
    run,
    hints: {
      runId: r.runId,
      projectDir: r.projectDir,
      sessionId: r.sessionId,
      cwds: [...new Set(agents.map((a) => a.cwd).filter((c): c is string => Boolean(c)))],
      agentIds: agents.map((a) => a.id),
      start,
    },
  };
}

function sessionCwdOf(sessionDir: string, sessionId: string): string | null {
  const head = readText(join(dirname(sessionDir), `${sessionId}.jsonl`), 65536);
  const m = head ? /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head) : null;
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return null;
  }
}
