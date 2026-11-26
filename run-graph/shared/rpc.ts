import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { edgeSchema, runSchema } from "./model.ts";

export const listRunsRpc = defineRpc({
  name: "runs.list",
  input: z.object({
    workspacePath: z.string(),
    /** Runs whose files changed in the last N days. */
    days: z.number().int().positive().max(365).optional(),
  }),
  output: z.object({
    repoRoot: z.string().nullable(),
    checkouts: z.array(z.string()),
    /** Every run, items without blocks. Children are runs too; edges say who hangs where. */
    runs: z.array(runSchema),
    edges: z.array(edgeSchema),
    errors: z.array(z.string()),
    readAt: z.number(),
  }),
});

export const runDetailRpc = defineRpc({
  name: "runs.detail",
  input: z.object({ workspacePath: z.string(), runId: z.string() }),
  output: z.object({ run: runSchema.nullable() }),
});

export const liveCountRpc = defineRpc({
  name: "runs.live-count",
  input: z.object({ workspacePath: z.string() }),
  output: z.object({ live: z.number().int() }),
});
