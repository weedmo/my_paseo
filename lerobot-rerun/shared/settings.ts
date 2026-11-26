import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const settingsSchema = z.object({
  /** Folders on this host that are searched for LeRobot datasets. */
  roots: z.array(z.string()).default(["~/.cache/huggingface/lerobot"]),
  /** Python with rerun-sdk, pyarrow, av and pillow. Empty means find one automatically. */
  pythonPath: z.string().default(""),
  /** Name the app uses to reach this host in the viewer address. */
  viewerHost: z.string().default("localhost"),
});
export type ViewerSettings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: ViewerSettings = settingsSchema.parse({});

export const viewerSettings = defineSettings({
  id: "lerobot-rerun",
  scope: "host",
  version: 1,
  schema: settingsSchema,
});

/** Folders added from the dataset screen, per host, kept on this device. */
export const folderSettings = defineSettings({
  id: "lerobot-rerun-folders",
  scope: "device",
  version: 1,
  schema: z.object({ byHost: z.record(z.string(), z.array(z.string())).default({}) }),
});

export const connectionSchema = z.object({
  id: z.string(),
  /** Empty string for the host that serves the screen. */
  serverId: z.string(),
  hostLabel: z.string(),
  path: z.string(),
  name: z.string(),
  /** A dataset folder, or a folder that holds several datasets. */
  kind: z.enum(["dataset", "collection"]),
});
export type Connection = z.infer<typeof connectionSchema>;

/** Dataset folders connected from the dataset screen, kept on this device like a workspace list. */
export const connectionSettings = defineSettings({
  id: "lerobot-rerun-connections",
  scope: "device",
  version: 1,
  schema: z.object({ connections: z.array(connectionSchema).default([]) }),
});

/** Viewer choices remembered on this device. */
export const viewerPreferences = defineSettings({
  id: "lerobot-rerun-viewer",
  scope: "device",
  version: 1,
  schema: z.object({ quality: z.enum(["preview", "original"]).default("preview") }),
});

/** Which parts of the sidebar tree are open, kept on this device. */
export const sidebarSettings = defineSettings({
  id: "lerobot-rerun-sidebar",
  scope: "device",
  version: 1,
  schema: z.object({
    /** The "LeRobot datasets" row toggles the whole tree. */
    open: z.boolean().default(false),
    /** Connection ids, and connection id + "\n" + dataset path for datasets inside a folder. */
    expanded: z.array(z.string()).default([]),
  }),
});

/** Open tabs of each connection, kept on this device: "episodes" or "file:<path in the folder>". */
export const tabSettings = defineSettings({
  id: "lerobot-rerun-tabs",
  scope: "device",
  version: 1,
  schema: z.object({
    byConnection: z.record(z.string(), z.object({ tabs: z.array(z.string()), active: z.string() })).default({}),
  }),
});
