// The normalized run model shared by the daemon and the app.
//
// It keeps the model of the Herdr workflow-graph mod (loops.py):
//   {source, name, status, live, start, stats, phases[{title, mode}], agentList[item]}
// and adds the parent/child links built by server/link.ts.
//
// Phase modes:
//   time        lanes from real start/end overlap (workflow agents, autocode experiments)
//   parallel    every item forks from the phase on its own lane
//   sequential  items chain one after another
import { z } from "zod";

export const itemStateSchema = z.enum(["done", "running", "queued", "failed", "stopped"]);
export type ItemState = z.infer<typeof itemStateSchema>;

export const sourceSchema = z.enum(["workflow", "matt", "autocode"]);
export type RunSource = z.infer<typeof sourceSchema>;

/** Which writer produced the run. `source` is the coarse filter group. */
export const kindSchema = z.enum(["workflow", "session", "matt-auto", "matt-design", "matt-log", "autocode"]);
export type RunKind = z.infer<typeof kindSchema>;

export const phaseModeSchema = z.enum(["time", "parallel", "sequential"]);
export type PhaseMode = z.infer<typeof phaseModeSchema>;

export const blockSchema = z.object({ title: z.string(), text: z.string() });
export type Block = z.infer<typeof blockSchema>;

export const itemSchema = z.object({
  id: z.string(),
  label: z.string(),
  tag: z.string().nullable(),
  phase: z.string(),
  state: itemStateSchema,
  start: z.number().nullable(),
  end: z.number().nullable(),
  sub: z.string(),
  stateText: z.string().nullable(),
  facts: z.array(z.string()),
  /** Prompt, result, notes. Empty in list payloads; filled by runDetail. */
  blocks: z.array(blockSchema),
});
export type Item = z.infer<typeof itemSchema>;

export const phaseSchema = z.object({ title: z.string(), mode: phaseModeSchema });
export type Phase = z.infer<typeof phaseSchema>;

export const evidenceSchema = z.enum([
  "explicit id",
  "worktree match",
  "session time window",
  "run time window",
  "design slug",
  "design title",
  "spec path",
]);
export type Evidence = z.infer<typeof evidenceSchema>;

export const confidenceSchema = z.enum(["certain", "inferred"]);
export type Confidence = z.infer<typeof confidenceSchema>;

export const edgeSchema = z.object({
  parentRunId: z.string(),
  /** null: the child hangs off the parent run itself, not one of its items. */
  parentItemId: z.string().nullable(),
  childRunId: z.string(),
  evidence: evidenceSchema,
  confidence: confidenceSchema,
  /** What exactly matched, for the detail pane. */
  detail: z.string(),
});
export type Edge = z.infer<typeof edgeSchema>;

export const runRefSchema = z.object({
  runId: z.string(),
  itemId: z.string().nullable(),
  evidence: evidenceSchema,
  confidence: confidenceSchema,
});
export type RunRef = z.infer<typeof runRefSchema>;

export const runSchema = z.object({
  runId: z.string(),
  source: sourceSchema,
  kind: kindSchema,
  name: z.string(),
  status: z.string(),
  live: z.boolean(),
  start: z.number().nullable(),
  mtime: z.number(),
  /** The checkout (loop runs) or the Claude session cwd (workflow runs). */
  location: z.string(),
  stats: z.string(),
  current: z.string().nullable(),
  phases: z.array(phaseSchema),
  agentList: z.array(itemSchema),
  /** Problems found while reading, such as a dependency cycle. Shown, never fatal. */
  errors: z.array(z.string()),
  facts: z.array(z.string()),
  children: z.array(runRefSchema),
  parent: runRefSchema.nullable(),
});
export type Run = z.infer<typeof runSchema>;

export const SOURCE_LABEL: Record<RunKind, string> = {
  workflow: "WF",
  session: "agents",
  "matt-auto": "matt",
  "matt-design": "design",
  "matt-log": "matt log",
  autocode: "auto",
};
