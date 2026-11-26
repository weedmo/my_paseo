// matt-design, matt-auto and autocode runs, normalized to the shared run model.
// Ported from the Herdr workflow-graph mod (loops.py) and updated to the
// weed-harness 7.4 "purpose loops" contracts:
//
//   plan session   matt-design → docs/design/<slug>.md (frontmatter: kind, loop, status, revision, mode)
//   build session  matt-auto   → docs/agents/matt-auto-log/<slug>.data.json (full mode board)
//                                 docs/agents/matt-auto-log/<slug>.md        (decision log; core mode has only this)
//                  autocode    → .autocode/report/autocode.data.json, .autocode/program.md (spec: line)
//   gates          qa-gate     → .qa/<unit>/result.json
//                  review-gate → .review/<unit>/round-<n>.json, verdict.json (bound to HEAD)
//                  pr-visual   → .pr-visual/<unit>/changes.json
//   unit = matt-auto-<slug> | autocode-<slug>
//
// Legacy files the mod also read stay supported: out/design/*/run.data.json and
// scratch/matt-auto-log.
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { ticketLevels } from "../shared/dag.ts";
import type { Block, Item, ItemState, Phase, Run, RunKind } from "../shared/model.ts";
import { arr, clip, isFile, isoMs, list, mtimeMs, num, obj, readJson, readText, str } from "./fsutil.ts";
import type { LoopHint, LoopItemHint } from "./link.ts";

const MATT_STATE: Record<string, ItemState> = {
  done: "done",
  "in-progress": "running",
  pending: "queued",
  blocked: "failed",
  skipped: "stopped",
  failed: "failed",
  ok: "done",
};
const AUTO_STATE: Record<string, ItemState> = {
  keep: "done",
  running: "running",
  measured: "running",
  discard: "stopped",
  crash: "failed",
  conflict: "failed",
  interaction: "failed",
  pending: "queued",
  cancelled: "stopped",
};

export interface LoopFile {
  kind: RunKind;
  path: string;
  checkout: string;
}

export interface LoopRead {
  run: Run;
  hint: LoopHint;
}

export interface ReadOpts {
  now: number;
  withBlocks: boolean;
  /** HEAD of the checkout, for the review-gate staleness check. */
  head?: (checkout: string) => string | null;
}

// ---- discovery

export function discoverLoops(checkouts: readonly string[]): LoopFile[] {
  const out: LoopFile[] = [];
  for (const root of checkouts) {
    for (const dir of ["docs/agents/matt-auto-log", "scratch/matt-auto-log"]) {
      const base = join(root, dir);
      const files = list(base);
      for (const f of files) {
        if (f.endsWith(".data.json")) out.push({ kind: "matt-auto", path: join(base, f), checkout: root });
        else if (f.endsWith(".md") && !files.includes(`${f.slice(0, -3)}.data.json`)) out.push({ kind: "matt-log", path: join(base, f), checkout: root });
      }
    }
    const design = join(root, "docs", "design");
    for (const f of list(design)) {
      if (f.endsWith(".md") && specFrontmatter(join(design, f))) out.push({ kind: "matt-design", path: join(design, f), checkout: root });
    }
    for (const d of list(join(root, "out", "design"))) {
      const f = join(root, "out", "design", d, "run.data.json");
      if (isFile(f)) out.push({ kind: "matt-design", path: f, checkout: root });
    }
    const auto = join(root, ".autocode", "report", "autocode.data.json");
    if (isFile(auto)) out.push({ kind: "autocode", path: auto, checkout: root });
  }
  return out;
}

/** Files whose change should invalidate a parse of `f`. */
export function loopStampPaths(f: LoopFile): string[] {
  const paths = [f.path];
  if (f.kind === "matt-auto") paths.push(f.path.replace(/\.data\.json$/, ".md"));
  if (f.kind === "autocode") paths.push(join(f.checkout, ".autocode", "program.md"));
  for (const unit of gateUnits(f)) {
    for (const g of [".qa", ".review", ".pr-visual"]) {
      const dir = join(f.checkout, g, unit);
      paths.push(dir, ...list(dir).map((x) => join(dir, x)));
    }
  }
  return paths;
}

function gateUnits(f: LoopFile): string[] {
  if (f.kind === "matt-auto" || f.kind === "matt-log") {
    const slug = basename(f.path).replace(/\.data\.json$|\.md$/, "");
    return [`matt-auto-${slug}`];
  }
  if (f.kind === "autocode") {
    const units = new Set<string>();
    for (const g of [".qa", ".review", ".pr-visual"]) for (const d of list(join(f.checkout, g))) if (d.startsWith("autocode-")) units.add(d);
    return [...units];
  }
  return [];
}

// ---- helpers

const item = (p: Partial<Item> & Pick<Item, "id" | "label" | "phase" | "state">): Item => ({
  tag: null,
  start: null,
  end: null,
  sub: "",
  stateText: null,
  facts: [],
  blocks: [],
  ...p,
});

const blocks = (pairs: [string, unknown][]): Block[] =>
  pairs
    .map(([title, v]) => [title, typeof v === "string" ? v : v == null ? "" : JSON.stringify(v, null, 1)] as const)
    .filter(([, t]) => Boolean(t) && t !== "[]" && t !== "{}")
    .map(([title, text]) => ({ title, text: clip(text, 4000) }));

const facts = (xs: (string | null | undefined | false)[]): string[] => xs.filter((x): x is string => Boolean(x));

function runStatus(d: Record<string, unknown>): string {
  const st = str(obj(d.progress).state);
  if (st === "running" || st === "blocked" || st === "done") return st;
  return d.outcome ? "done" : "running";
}

/** A worktree path from a worker record; free text such as "Workflow worktree" is not one. */
export function worktreePath(raw: unknown, checkout: string): string | null {
  const s = str(raw);
  if (!s || /\s/.test(s) || !s.includes("/")) return null;
  if (s.startsWith("~/")) return join(process.env.HOME ?? "~", s.slice(2));
  return isAbsolute(s) ? s : resolve(checkout, s);
}

const SPEC_RE = /((?:~\/|\/|\.\/)?[\w.@-]*(?:\/[\w.@-]+)*\/?docs\/design\/[\w.@-]+\.md)/g;

/** Spec paths a text mentions, absolute. */
export function specPathsIn(text: string, checkout: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(SPEC_RE)) {
    const p = m[1];
    out.add(p.startsWith("~/") ? join(process.env.HOME ?? "~", p.slice(2)) : isAbsolute(p) ? p : resolve(checkout, p));
  }
  return [...out];
}

// ---- matt-auto board (full mode) and the legacy matt-design run.data.json

function mattBoard(d: Record<string, unknown>, opts: ReadOpts, checkout: string) {
  const phases: Phase[] = [];
  const items: Item[] = [];
  const hints: LoopItemHint[] = [];
  const errors: string[] = [];
  const stages = arr(d.stages).map(obj).filter((st) => st.id !== "implement" && st.id !== "ship");
  if (stages.length) {
    phases.push({ title: "Design", mode: "sequential" });
    for (const st of stages) {
      const decs = arr(st.decisions).map(obj);
      items.push(
        item({
          id: `stage:${str(st.id) ?? "?"}`,
          label: str(st.name) ?? str(st.id) ?? "stage",
          phase: "Design",
          state: MATT_STATE[str(st.status) ?? ""] ?? "queued",
          sub: decs.length ? `${decs.length} decisions` : "",
          facts: facts([str(st.skill), str(st.note)]),
          blocks: opts.withBlocks
            ? decs.slice(0, 20).map((dc) => ({ title: str(dc.question) ?? str(dc.id) ?? "decision", text: clip([str(dc.decision), str(dc.rationale)].filter(Boolean).join("\n\n")) }))
            : [],
        }),
      );
      hints.push({ itemId: `stage:${str(st.id)}`, worktree: null, window: null, text: JSON.stringify(st) });
    }
  }
  const tickets = arr(d.tickets).map(obj);
  const byId = new Map(tickets.map((t) => [str(t.id) ?? "", t]));
  // Validate the DAG even when a plan exists: a cycle must show, not hang.
  const dag = ticketLevels(tickets.map((t) => ({ id: str(t.id) ?? "", blockedBy: t.blockedBy })));
  errors.push(...dag.errors);
  let waves = arr(obj(d.plan).waves).map(obj);
  if (!waves.length && tickets.length) {
    const max = Math.max(0, ...dag.levels.values());
    waves = Array.from({ length: max + 1 }, (_, n) => ({
      id: `L${n + 1}`,
      mode: "parallel",
      tickets: [...dag.levels].filter(([, l]) => l === n).map(([id]) => id),
    }));
  }
  const placed = new Set<string>();
  for (const w of waves) {
    const title = `${str(w.id) ?? "wave"} · ${w.mode === "sequential" ? "sequential" : "parallel"}`;
    phases.push({ title, mode: w.mode === "sequential" ? "sequential" : "parallel" });
    for (const tidRaw of arr(w.tickets)) {
      const tid = String(tidRaw);
      const t = byId.get(tid);
      if (!t) {
        errors.push(`Wave ${str(w.id)} names unknown ticket ${tid}`);
        continue;
      }
      placed.add(tid);
      const r = ticket(t, title, opts, checkout);
      items.push(r.item);
      hints.push(r.hint);
    }
  }
  const stray = tickets.filter((t) => !placed.has(str(t.id) ?? ""));
  if (stray.length && waves.length) {
    phases.push({ title: "Unplanned", mode: "parallel" });
    for (const t of stray) {
      const r = ticket(t, "Unplanned", opts, checkout);
      items.push(r.item);
      hints.push(r.hint);
    }
  }
  const rv = d.review ? obj(d.review) : null;
  if (rv) {
    phases.push({ title: "Review", mode: "sequential" });
    for (const p of arr(rv.passes).map(obj)) {
      const reviewer = obj(p.reviewer);
      items.push(
        item({
          id: `review:${str(p.id) ?? "?"}`,
          label: str(p.name) ?? str(p.id) ?? "pass",
          phase: "Review",
          state: MATT_STATE[str(p.status) ?? ""] ?? "queued",
          sub: num(p.findings) != null ? `${num(p.findings)} findings` : "",
          facts: facts([str(rv.skill), str(reviewer.family) ?? str(p.reviewer), p.cross_model ? "cross-model" : null]),
          blocks: opts.withBlocks ? blocks([["note", p.note]]) : [],
        }),
      );
    }
  }
  const pr = d.pr ? obj(d.pr) : null;
  if (pr) {
    const title = num(pr.number) != null ? `PR #${num(pr.number)}` : "PR";
    phases.push({ title, mode: "parallel" });
    arr(pr.checks)
      .map(obj)
      .forEach((c, i) =>
        items.push(
          item({
            id: `pr:${i}`,
            label: str(c.name) ?? "check",
            phase: title,
            state: MATT_STATE[str(c.status) ?? ""] ?? "queued",
            facts: facts([str(c.detail)]),
            blocks: opts.withBlocks ? blocks([["PR", pr.url]]) : [],
          }),
        ),
      );
  }
  const done = tickets.filter((t) => t.status === "done").length;
  return { phases, items, hints, errors, stats: tickets.length ? `tickets ${done}/${tickets.length}` : "" };
}

function ticket(t: Record<string, unknown>, phase: string, opts: ReadOpts, checkout: string): { item: Item; hint: LoopItemHint } {
  const tid = str(t.id) ?? "?";
  const start = isoMs(t.startedAt);
  const actual = num(t.actualMin);
  const estimate = num(t.estimateMin);
  const end = start != null && actual != null ? start + actual * 60000 : null;
  const worker = obj(t.worker);
  const g = obj(t.gates);
  const gates = num(g.total) ? `${num(g.met) ?? 0}/${num(g.total)}` : "";
  const b = t.blocker ? obj(t.blocker) : null;
  const state = MATT_STATE[str(t.status) ?? ""] ?? "queued";
  const wt = worktreePath(worker.worktree, checkout);
  // The window the ticket's worker ran in: actualMin, else running until now,
  // else twice the estimate. Used only for inferred links.
  const windowEnd = end ?? (state === "running" ? opts.now : start != null && estimate != null ? start + estimate * 2 * 60000 : null);
  const it = item({
    id: `ticket:${tid}`,
    label: str(t.title) ?? tid,
    tag: tid,
    phase,
    state,
    start,
    end,
    sub: gates || (estimate != null && end == null ? `~${estimate}m` : ""),
    stateText: t.status === "blocked" ? "blocked" : null,
    facts: facts([
      str(t.route),
      [str(worker.model), str(worker.effort)].filter(Boolean).join("/") || null,
      str(t.engine) ?? str(worker.engine),
      str(worker.dispatchId) ? `hc ${str(worker.dispatchId)}` : null,
      gates ? `gates ${gates}` : null,
      arr(t.blockedBy).length ? `blocked by ${arr(t.blockedBy).join(", ")}` : null,
      estimate != null ? `estimate ${estimate}m` : null,
      actual != null ? `actual ${actual}m` : null,
    ]),
    blocks: opts.withBlocks
      ? blocks([
          ["blocker", b ? `${str(b.reason) ?? ""} — ${str(b.detail) ?? ""}` : null],
          ["note", t.note],
          ["worktree", str(worker.worktree)],
          ["acceptance", arr(t.acceptance).map(String).join("\n")],
          ["steps", arr(t.steps).map((s) => `${str(obj(s).status) ?? ""} ${str(obj(s).name) ?? ""}`).join("\n")],
          ["gates", arr(t.gateList).map((x) => `${str(obj(x).status) ?? ""} ${str(obj(x).id) ?? ""} ${str(obj(x).text) ?? ""}`).join("\n")],
          ["commits", arr(t.commits).map((c) => `${str(obj(c).sha)?.slice(0, 8) ?? ""} ${str(obj(c).subject) ?? ""}`).join("\n")],
          ["files", arr(t.files).map((f) => `${str(obj(f).path) ?? ""} +${num(obj(f).added) ?? 0} -${num(obj(f).removed) ?? 0}`).join("\n")],
        ])
      : [],
  });
  return {
    item: it,
    hint: { itemId: it.id, worktree: wt, window: start != null && windowEnd != null ? [start, windowEnd] : null, text: JSON.stringify(t) },
  };
}

// ---- matt-auto decision log (.md): core mode's only record, and the fallback

interface MdSection {
  name: string;
  body: string;
}

function mdSections(text: string): { title: string | null; sections: MdSection[] } {
  const lines = text.split("\n");
  const title = /^#\s+(?:matt-auto log:\s*)?(.+)/i.exec(lines[0] ?? "");
  const sections: MdSection[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith("## ")) sections.push({ name: line.slice(3).trim(), body: "" });
    else if (sections.length) sections[sections.length - 1].body += `${line}\n`;
  }
  return { title: title ? title[1].trim() : null, sections };
}

/** "mode: core" / "모드: core" / "core mode" in the log. */
function mdMode(text: string): string | null {
  const m = /\bmode\b[^\n]{0,20}?\b(core|full)\b/i.exec(text) ?? /\b(core|full)\s+mode\b/i.exec(text);
  return m ? m[1].toLowerCase() : null;
}

// ---- gates: qa-gate, review-gate, pr-visual

function gates(checkout: string, units: readonly string[], opts: ReadOpts): { phases: Phase[]; items: Item[] } {
  const phases: Phase[] = [];
  const items: Item[] = [];
  for (const unit of units) {
    const qa = obj(readJson(join(checkout, ".qa", unit, "result.json")));
    const plan = obj(readJson(join(checkout, ".qa", unit, "plan.json")));
    if (Object.keys(qa).length || Object.keys(plan).length) {
      const title = "QA gate";
      if (!phases.some((p) => p.title === title)) phases.push({ title, mode: "parallel" });
      const scenarios = arr(qa.scenarios).map(obj);
      if (!scenarios.length) {
        for (const s of arr(plan.scenarios).map(obj))
          items.push(item({ id: `qa:${unit}:${str(s.id)}`, label: str(s.acceptance) ?? str(s.id) ?? "scenario", tag: str(s.id), phase: title, state: "queued", facts: facts([str(s.driver), str(s.kind)]) }));
      }
      for (const s of scenarios) {
        const exit = num(s.exit);
        items.push(
          item({
            id: `qa:${unit}:${str(s.id)}`,
            label: str(s.acceptance) ?? str(s.id) ?? "scenario",
            tag: str(s.id),
            phase: title,
            state: exit === 0 ? "done" : "failed",
            sub: num(s.duration_ms) != null ? `${Math.round(num(s.duration_ms)! / 1000)}s` : "",
            facts: facts([str(qa.surface), exit != null ? `exit ${exit}` : null, str(qa.ran_at)]),
            blocks: opts.withBlocks ? blocks([["output", s.output]]) : [],
          }),
        );
      }
      for (const j of arr(qa.judged).map(obj))
        items.push(item({ id: `qa:${unit}:${str(j.id)}:judged`, label: str(j.acceptance) ?? str(j.id) ?? "judged", tag: str(j.id), phase: title, state: "queued", stateText: "manual" }));
    }
    const reviewDir = join(checkout, ".review", unit);
    const rounds = list(reviewDir)
      .map((f) => /^round-(\d+)\.json$/.exec(f))
      .filter((m): m is RegExpExecArray => Boolean(m))
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
    const verdict = obj(readJson(join(reviewDir, "verdict.json")));
    if (rounds.length || Object.keys(verdict).length) {
      const title = "Review gate";
      if (!phases.some((p) => p.title === title)) phases.push({ title, mode: "sequential" });
      for (const n of rounds) {
        const r = obj(readJson(join(reviewDir, `round-${n}.json`)));
        const triage = obj(readJson(join(reviewDir, `triage-${n}.json`)));
        const findings = arr(r.findings).map(obj);
        const sev = (s: string) => findings.filter((f) => f.severity === s).length;
        const reviewers = arr(r.reviewers).map(obj);
        items.push(
          item({
            id: `review-gate:${unit}:${n}`,
            label: `round ${n}`,
            phase: title,
            state: "done",
            sub: `${findings.length} findings`,
            facts: facts([
              ...reviewers.map((x) => [str(x.family), str(x.model), str(x.effort)].filter(Boolean).join(" ")),
              `blocker ${sev("blocker")} · major ${sev("major")} · minor ${sev("minor")}`,
            ]),
            blocks: opts.withBlocks
              ? [
                  ...findings.slice(0, 30).map((f) => ({
                    title: `${str(f.severity) ?? ""} ${str(f.axis) ?? ""} ${str(f.file) ?? ""}${num(f.line) != null ? `:${num(f.line)}` : ""}`.trim(),
                    text: clip([str(f.claim), str(f.evidence)].filter(Boolean).join("\n\n")),
                  })),
                  ...blocks([["triage", arr(triage.decisions).map((x) => `${str(obj(x).decision) ?? ""} ${str(obj(x).id) ?? ""}: ${str(obj(x).reason) ?? ""}`).join("\n")]]),
                ]
              : [],
          }),
        );
      }
      if (Object.keys(verdict).length) {
        const status = str(verdict.status) ?? "?";
        const sha = str(verdict.reviewed_sha);
        const head = opts.head?.(checkout) ?? null;
        const stale = status === "PASS" && sha != null && head != null && sha !== head;
        const counts = obj(verdict.counts);
        items.push(
          item({
            id: `review-gate:${unit}:verdict`,
            label: `verdict ${status}`,
            phase: title,
            state: stale ? "stopped" : status === "PASS" ? "done" : status === "STOP" ? "failed" : "running",
            stateText: stale ? "stale" : status,
            sub: sha ? sha.slice(0, 8) : "",
            facts: facts([
              str(verdict.writer) ? `writer ${str(verdict.writer)}` : null,
              verdict.cross_model ? "cross-model" : null,
              `rounds ${num(verdict.rounds) ?? "?"}/${num(verdict.max_cycles) ?? "?"}`,
              `blocker ${num(counts.blocker) ?? 0} · major ${num(counts.major) ?? 0} · minor ${num(counts.minor) ?? 0}`,
              stale ? `HEAD moved to ${head!.slice(0, 8)} after the review` : null,
            ]),
            blocks: opts.withBlocks ? blocks([["reasons", arr(verdict.reasons).map(String).join("\n")], ["open", verdict.open], ["minor", verdict.minor]]) : [],
          }),
        );
      }
    }
    const changes = obj(readJson(join(checkout, ".pr-visual", unit, "changes.json")));
    const changesHtml = join(checkout, ".pr-visual", unit, "changes.html");
    if (Object.keys(changes).length || isFile(changesHtml)) {
      const title = "PR visual";
      if (!phases.some((p) => p.title === title)) phases.push({ title, mode: "sequential" });
      const points = arr(changes.points).map(obj);
      items.push(
        item({
          id: `pr-visual:${unit}`,
          label: str(changes.title) ?? "As-Is / To-Be page",
          phase: title,
          state: isFile(changesHtml) ? "done" : "running",
          sub: points.length ? `${points.length} points` : "",
          facts: facts([str(changes.summary)]),
          blocks: opts.withBlocks
            ? [
                ...blocks([["page", isFile(changesHtml) ? changesHtml : null]]),
                ...points.slice(0, 20).map((p) => ({ title: `${str(p.title) ?? "change"} — ${str(p.file) ?? ""}`, text: clip([str(p.what), str(p.why)].filter(Boolean).join("\n\n")) })),
              ]
            : [],
        }),
      );
    }
  }
  return { phases, items };
}

// ---- matt-design spec (plan session)

export interface SpecFrontmatter {
  [key: string]: string;
}

/** The YAML frontmatter of a matt-design (or legacy design-map) spec, else null. */
export function specFrontmatter(path: string): SpecFrontmatter | null {
  const text = readText(path, 8192);
  if (!text || !text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const fm: SpecFrontmatter = {};
  for (const line of text.slice(3, end).split("\n")) {
    const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(line.trim());
    if (m) fm[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return "matt-design" in fm || "design-map" in fm ? fm : null;
}

function mdTableRows(body: string): string[][] {
  return body
    .split("\n")
    .filter((l) => l.trim().startsWith("|") && !/^\|\s*-/.test(l.trim()))
    .map((l) =>
      l
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim()),
    )
    .slice(1); // header
}

function readSpec(f: LoopFile, opts: ReadOpts): LoopRead {
  const text = readText(f.path) ?? "";
  const fm = specFrontmatter(f.path) ?? {};
  const body = text.slice(text.indexOf("\n---", 3) + 4);
  const { title, sections } = mdSections(body.replace(/^\s*\n/, ""));
  const h1 = /^#\s+(.+)$/m.exec(body);
  const status = fm.status || "draft";
  const confirmed = status === "confirmed";
  const phases: Phase[] = [];
  const items: Item[] = [];
  const decisions = sections.find((s) => /결정|decision/i.test(s.name));
  if (decisions) {
    phases.push({ title: "Decisions", mode: "sequential" });
    for (const row of mdTableRows(decisions.body)) {
      const [id, question, choice, why] = row;
      if (!id) continue;
      items.push(
        item({
          id: `decision:${id}`,
          label: question ?? id,
          tag: id,
          phase: "Decisions",
          state: confirmed ? "done" : "running",
          facts: facts([choice]),
          blocks: opts.withBlocks ? blocks([["choice", choice], ["why", why]]) : [],
        }),
      );
    }
  }
  const steps = sections.find((s) => /구현 순서|implementation order|steps/i.test(s.name));
  if (steps) {
    phases.push({ title: "Build steps", mode: "sequential" });
    let n = 0;
    for (const line of steps.body.split("\n")) {
      const m = /^\s*\d+\.\s+(?:\[(deep|default)\]\s*)?(.+)$/.exec(line);
      if (!m) continue;
      n += 1;
      items.push(item({ id: `step:${n}`, label: m[2].replace(/\s*확인:.*$/, ""), tag: m[1] ?? null, phase: "Build steps", state: "queued", blocks: opts.withBlocks ? blocks([["step", m[2]]]) : [] }));
    }
  }
  const acceptance = sections.find((s) => /수용 기준|acceptance/i.test(s.name));
  const mtime = mtimeMs(f.path) ?? 0;
  const rel = relative(f.checkout, f.path);
  const slug = fm.slug || basename(f.path, ".md");
  const run: Run = {
    runId: f.path,
    source: "matt",
    kind: "matt-design",
    name: h1 ? h1[1].trim() : (title ?? slug),
    status,
    live: false,
    start: null,
    mtime,
    location: f.checkout,
    stats: facts([fm.kind, fm.loop ? `→ ${fm.loop}` : null, fm.mode, fm.revision ? `rev ${fm.revision}` : null]).join(" · "),
    current: null,
    phases,
    agentList: items,
    errors: fm.kind && !["feature", "optimize", "research"].includes(fm.kind) ? [`Unknown spec kind: ${fm.kind}`] : [],
    facts: facts([rel, fm.artifact && fm.artifact !== "none" ? `artifact ${fm.artifact}` : null, fm.branch ? `branch ${fm.branch}` : null, acceptance ? `${acceptance.body.split("\n").filter((l) => /^\s*\d+\./.test(l)).length} acceptance criteria` : null]),
    children: [],
    parent: null,
  };
  return {
    run,
    hint: { runId: run.runId, kind: "matt-design", checkout: f.checkout, slug, title: run.name, specPaths: [], ownSpecPaths: [f.path, rel], window: null, items: [], text: "" },
  };
}

// ---- readers

export function readLoop(f: LoopFile, opts: ReadOpts): LoopRead {
  if (f.kind === "matt-design" && f.path.endsWith(".md")) return readSpec(f, opts);
  if (f.kind === "matt-log") return readMattLog(f, opts);
  const d = obj(readJson(f.path));
  const mtime = mtimeMs(f.path) ?? 0;
  const progress = obj(d.progress);
  const status = runStatus(d);
  const base = {
    runId: f.path,
    status,
    live: status !== "done",
    start: isoMs(progress.startedAt),
    mtime,
    location: f.checkout,
    current: str(progress.current),
    children: [],
    parent: null,
  };
  const blockers = arr(progress.blockers).map(obj).map((b) => `${str(b.title) ?? ""}: ${str(b.reason) ?? ""} — ${str(b.detail) ?? ""}`);
  const updated = isoMs(progress.updated);
  const window: [number, number] | null = base.start != null ? [base.start, status === "done" ? (updated ?? mtime) : opts.now] : null;
  if (f.kind === "autocode") return readAutocode(f, d, base, blockers, window, opts);
  // matt-auto (full) or a legacy matt-design run.data.json
  const board = mattBoard(d, opts, f.checkout);
  const mdPath = f.path.replace(/\.data\.json$/, ".md");
  const md = f.kind === "matt-auto" ? (readText(mdPath) ?? "") : "";
  const designNote = arr(d.stages).map(obj).find((s) => s.id === "design");
  const specText = `${md}\n${str(designNote?.note) ?? ""}`;
  const extra = f.kind === "matt-auto" ? gates(f.checkout, gateUnits(f), opts) : { phases: [], items: [] };
  const mode = mdMode(md);
  const run: Run = {
    ...base,
    source: "matt",
    kind: f.kind,
    name: str(d.title) ?? basename(f.path),
    stats: board.stats,
    phases: [...board.phases, ...extra.phases],
    agentList: [...board.items, ...extra.items],
    errors: board.errors,
    facts: facts([relative(f.checkout, f.path), mode ? `mode ${mode}` : null, str(d.summary), ...blockers.map((b) => `blocker ${b}`), str(progress.note)]),
  };
  return {
    run,
    hint: {
      runId: run.runId,
      kind: f.kind === "matt-design" ? "matt-design" : "matt-auto",
      checkout: f.checkout,
      slug: str(d.slug),
      title: str(d.title),
      specPaths: specPathsIn(specText, f.checkout),
      ownSpecPaths: f.kind === "matt-design" ? [f.path] : [],
      window,
      items: board.hints,
      text: md,
    },
  };
}

function readMattLog(f: LoopFile, opts: ReadOpts): LoopRead {
  const text = readText(f.path) ?? "";
  const { title, sections } = mdSections(text);
  const mtime = mtimeMs(f.path) ?? 0;
  const slug = basename(f.path, ".md");
  const items = sections.map((s, i) =>
    item({ id: `log:${i}`, label: s.name, phase: "Decision log", state: "done", blocks: opts.withBlocks ? blocks([["log", s.body.trim()]]) : [] }),
  );
  const extra = gates(f.checkout, gateUnits(f), opts);
  const mode = mdMode(text);
  // A log only knows it ended when a review verdict passed; otherwise it may still be going.
  const verdict = extra.items.find((x) => x.id.endsWith(":verdict"));
  const status = verdict?.state === "done" ? "done" : "recorded";
  const run: Run = {
    runId: f.path,
    source: "matt",
    kind: "matt-log",
    name: title ?? slug,
    status,
    live: false,
    start: null,
    mtime,
    location: f.checkout,
    stats: facts([mode ? `${mode} mode` : null, `${sections.length} log sections`]).join(" · "),
    current: null,
    phases: [{ title: "Decision log", mode: "sequential" }, ...extra.phases],
    agentList: [...items, ...extra.items],
    errors: [],
    facts: facts([relative(f.checkout, f.path), mode === "core" ? "core mode: the main session implemented in-session, no board page" : null]),
    children: [],
    parent: null,
  };
  return {
    run,
    hint: {
      runId: run.runId,
      kind: "matt-auto",
      checkout: f.checkout,
      slug,
      title,
      specPaths: specPathsIn(text, f.checkout),
      ownSpecPaths: [],
      window: null,
      items: sections.map((s, i) => ({ itemId: `log:${i}`, worktree: null, window: null, text: s.body })),
      text,
    },
  };
}

function readAutocode(
  f: LoopFile,
  d: Record<string, unknown>,
  base: Pick<Run, "runId" | "status" | "live" | "start" | "mtime" | "location" | "current" | "children" | "parent">,
  blockers: string[],
  window: [number, number] | null,
  opts: ReadOpts,
): LoopRead {
  const run0 = obj(d.run);
  const metric = obj(run0.metric);
  const unit = str(metric.name) ?? "metric";
  const hyps = arr(d.hypotheses).map(obj);
  const notStarted = (h: Record<string, unknown>) => h.status === "pending" || h.status === "cancelled";
  const started = hyps.filter((h) => !notStarted(h)).sort((a, b) => (isoMs(a.startedAt) ?? Infinity) - (isoMs(b.startedAt) ?? Infinity) || (num(a.seq) ?? 0) - (num(b.seq) ?? 0));
  const rest = hyps.filter(notStarted).sort((a, b) => (num(a.priority) ?? 99) - (num(b.priority) ?? 99));
  const phases: Phase[] = [];
  if (started.length) phases.push({ title: "Experiments", mode: "time" });
  if (rest.length) phases.push({ title: "Frontier", mode: "sequential" });
  const items: Item[] = [];
  const hints: LoopItemHint[] = [];
  for (const h of [...started, ...rest]) {
    const st = str(h.status) ?? "pending";
    const delta = num(h.delta);
    const worker = obj(h.worker);
    const id = `hyp:${str(h.id) ?? "?"}`;
    const start = isoMs(h.startedAt);
    const end = isoMs(h.measuredAt);
    const state = AUTO_STATE[st] ?? "queued";
    items.push(
      item({
        id,
        label: str(h.claim) ?? "",
        tag: str(h.id),
        phase: notStarted(h) ? "Frontier" : "Experiments",
        state,
        start,
        end,
        stateText: st !== "running" ? st : null,
        sub: delta != null ? `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%` : (str(h.expectedDelta) ?? ""),
        facts: facts([
          str(h.route),
          str(h.difficulty),
          [str(worker.model), str(worker.effort)].filter(Boolean).join("/") || null,
          str(worker.dispatchId) ? `hc ${str(worker.dispatchId)}` : null,
          num(h.metric) != null ? `${unit} ${num(h.metric)}` : null,
          str(h.commit) ? `commit ${str(h.commit)}` : null,
          arr(h.dependsOn).length ? `depends on ${arr(h.dependsOn).join(", ")}` : null,
        ]),
        blocks: opts.withBlocks
          ? blocks([
              ["experiment", h.experiment],
              ["touches", arr(h.touches).join(", ")],
              ["if confirmed", h.ifConfirmed],
              ["if refuted", h.ifRefuted],
              ["note", h.note],
              ["obstacle", h.obstacle],
              ["worktree", str(worker.worktree)],
            ])
          : [],
      }),
    );
    hints.push({
      itemId: id,
      worktree: worktreePath(worker.worktree, f.checkout),
      window: start != null ? [start, end ?? (state === "running" ? opts.now : start)] : null,
      text: JSON.stringify(h),
    });
  }
  const extra = gates(f.checkout, gateUnits(f), opts);
  const program = readText(join(f.checkout, ".autocode", "program.md"), 16384) ?? "";
  const specLine = /^spec:\s*(\S+)/m.exec(program);
  const spec = specLine && specLine[1] !== "null" ? specLine[1] : null;
  const state = obj(readJson(join(f.checkout, ".autocode", "state.json")));
  const budget = obj(run0.budget);
  const best = num(metric.best);
  const baseline = num(metric.baseline);
  const run: Run = {
    ...base,
    source: "autocode",
    kind: "autocode",
    name: str(d.title) ?? "autocode",
    stats: facts([
      num(budget.max) != null ? `${num(budget.done) ?? 0}/${num(budget.max)} experiments` : null,
      best != null && baseline != null ? `${unit} ${baseline} → ${best}` : null,
      str(run0.terminatedReason),
    ]).join(" · "),
    phases: [...phases, ...extra.phases],
    agentList: [...items, ...extra.items],
    errors: [],
    facts: facts([
      relative(f.checkout, f.path),
      spec ? `spec ${spec}` : null,
      str(run0.branch) ? `branch ${str(run0.branch)}` : null,
      str(obj(run0.strategist).tier) ? `strategist ${str(obj(run0.strategist).tier)}` : null,
      str(state.strategist_agent_id) ? `strategist id ${str(state.strategist_agent_id)}` : null,
      ...blockers.map((b) => `blocker ${b}`),
    ]),
  };
  return {
    run,
    hint: {
      runId: run.runId,
      kind: "autocode",
      checkout: f.checkout,
      slug: spec ? basename(spec, ".md") : str(d.slug),
      title: str(d.title),
      specPaths: spec ? [spec.startsWith("~/") ? join(process.env.HOME ?? "~", spec.slice(2)) : isAbsolute(spec) ? spec : resolve(f.checkout, spec)] : [],
      ownSpecPaths: [],
      window,
      items: hints,
      text: `${program}\n${JSON.stringify(state)}`,
    },
  };
}
