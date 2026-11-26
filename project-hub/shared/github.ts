import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Resolve GitHub remotes ("github.com/owner/repo") to their canonical name and owner avatar, following renames. */
export const resolveGithubRepos = defineRpc({
  name: "github.resolve",
  input: z.object({ remotes: z.array(z.string()).max(200) }),
  output: z.object({
    /** remote -> canonical "github.com/owner/repo" (lowercase). Missing entries could not be resolved. */
    canonical: z.record(z.string(), z.string()),
    /** lowercase owner login -> small avatar as a data URI. */
    avatars: z.record(z.string(), z.string()),
  }),
});
