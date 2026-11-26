import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const sidebarPreferences = defineSettings({
  id: "sidebar",
  scope: "device",
  version: 1,
  schema: z.object({ collapsed: z.array(z.string()).default([]) }),
});
