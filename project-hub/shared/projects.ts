import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const target = z.object({ serverId: z.string().min(1), projectId: z.string().min(1) });
const outcome = z.object({
  serverId: z.string(),
  projectId: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  removedWorkspaces: z.number().optional(),
});

/** Set (or clear with null) the custom display name of host projects. */
export const renameProjects = defineRpc({
  name: "projects.rename",
  input: z.object({ targets: z.array(target).min(1).max(20), customName: z.string().max(200).nullable() }),
  output: z.object({ results: z.array(outcome) }),
});

/** Remove host projects from Paseo. Files on disk are not touched; the project's workspaces are archived. */
export const removeProjects = defineRpc({
  name: "projects.remove",
  input: z.object({ targets: z.array(target).min(1).max(20) }),
  output: z.object({ results: z.array(outcome) }),
});
