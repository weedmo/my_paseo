import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Runtime ID this plugin must have on every host that holds datasets. */
export const PLUGIN_ID = "lerobot-rerun";

export const hostSchema = z.object({
  serverId: z.string(),
  label: z.string(),
  /** The host that serves this screen; the Rerun viewer runs here. */
  self: z.boolean(),
  status: z.string(),
  error: z.string().nullable(),
  /** Network address of a remote host, from its connection; null for relay connections. */
  address: z.string().nullable(),
});
export type Host = z.infer<typeof hostSchema>;

export const datasetSchema = z.object({
  /** Absolute folder that holds meta/info.json, on the host that has the dataset. */
  path: z.string(),
  name: z.string(),
  version: z.string(),
  episodes: z.number(),
  frames: z.number(),
  fps: z.number(),
  robotType: z.string().nullable(),
  cameras: z.array(z.string()),
});
export type Dataset = z.infer<typeof datasetSchema>;

const extraValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))]);

export const episodeSchema = z.object({
  index: z.number(),
  length: z.number(),
  tasks: z.array(z.string()),
  /** Other per-episode metadata columns, such as grade or tags. */
  extra: z.record(z.string(), extraValue),
});
export type Episode = z.infer<typeof episodeSchema>;

/** preview: small re-encoded video that plays smoothly anywhere; original: the dataset's own video. */
export const qualitySchema = z.enum(["preview", "original"]);
export type Quality = z.infer<typeof qualitySchema>;

export const sessionSchema = z.object({
  id: z.string(),
  /** Name shown on the viewer's tab; null for viewers served to another computer. */
  title: z.string().nullable(),
  quality: qualitySchema,
  serverId: z.string(),
  hostLabel: z.string(),
  root: z.string(),
  episode: z.number(),
  state: z.enum(["preparing", "downloading", "starting", "ready", "error", "stopped"]),
  url: z.string().nullable(),
  /** Progress of the current state: steps while preparing, bytes while downloading. */
  done: z.number(),
  total: z.number(),
  message: z.string().nullable(),
});
export type Session = z.infer<typeof sessionSchema>;

/** Omitted serverId means the host that serves the call. */
const target = { serverId: z.string().optional() };

export const listHostsRpc = defineRpc({
  name: "hosts.list",
  input: z.object({}),
  output: z.object({ hosts: z.array(hostSchema), error: z.string().nullable() }),
});

export const listDatasetsRpc = defineRpc({
  name: "datasets.list",
  input: z.object({
    ...target,
    roots: z.array(z.string()).default([]),
    /** Skip the cached result; searches of network drives take up to 20 seconds. */
    refresh: z.boolean().default(false),
    /** Search only `roots`, not the folders configured in the host's settings. */
    only: z.boolean().default(false),
  }),
  output: z.object({ datasets: z.array(datasetSchema), errors: z.array(z.string()), searchedAt: z.number() }),
});

export const listEpisodesRpc = defineRpc({
  name: "episodes.list",
  input: z.object({ ...target, root: z.string() }),
  output: z.object({ episodes: z.array(episodeSchema) }),
});

export const folderEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  /** Set when the folder is a LeRobot dataset; null when it is not, or was not checked in time. */
  dataset: datasetSchema.nullable(),
});

export const folderListingSchema = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  /** Set when the listed folder is itself a dataset. */
  dataset: datasetSchema.nullable(),
  entries: z.array(folderEntrySchema),
  /** More folders exist than were listed, or some were not checked for datasets in time. */
  truncated: z.boolean(),
  shortcuts: z.array(z.object({ label: z.string(), path: z.string() })),
});
export type FolderListing = z.infer<typeof folderListingSchema>;

export const listFolderRpc = defineRpc({
  name: "folders.list",
  input: z.object({ ...target, path: z.string().optional() }),
  output: folderListingSchema,
});

/** Starts preparing a viewer for one episode and returns at once; poll viewer.sessions. */
export const openEpisodeRpc = defineRpc({
  name: "viewer.open",
  input: z.object({ ...target, root: z.string(), episode: z.number().int().min(0), quality: qualitySchema.default("preview") }),
  output: sessionSchema,
});

/**
 * Called by a viewer host on the host that holds the dataset: serve the episode live from here,
 * advertised at `host`, the address the caller reaches this machine at.
 */
export const viewerServeRpc = defineRpc({
  name: "viewer.serve",
  input: z.object({
    root: z.string(),
    episode: z.number().int().min(0),
    host: z.string().min(1),
    quality: qualitySchema.default("preview"),
  }),
  output: sessionSchema,
});

/**
 * Shows a viewer in the viewer page, which holds every open viewer as a tab of its own. Returns the
 * page URL and whether the page is open right now, so the app opens it only when it is not.
 */
export const viewerFocusRpc = defineRpc({
  name: "viewer.focus",
  input: z.object({ id: z.string().nullable() }),
  output: z.object({ url: z.string(), alive: z.boolean() }),
});

/** Viewers on this host, newest first. */
export const sessionsRpc = defineRpc({
  name: "viewer.sessions",
  input: z.object({}),
  output: z.object({ sessions: z.array(sessionSchema), max: z.number() }),
});

/** Stops one viewer, or every viewer without an id. */
export const stopRpc = defineRpc({
  name: "viewer.stop",
  input: z.object({ id: z.string().optional() }),
  output: z.object({ ok: z.literal(true) }),
});

/** The workspace on this host whose browser tabs show the viewers. Created on first use. */
export const viewerWorkspaceRpc = defineRpc({
  name: "viewer.workspace",
  input: z.object({}),
  output: z.object({ workspaceId: z.string(), directory: z.string() }),
});

// Called by the viewer host on the host that holds the dataset.

export const exportStatusSchema = z.object({
  state: z.enum(["running", "done", "error"]),
  done: z.number(),
  total: z.number(),
  bytes: z.number(),
  message: z.string().nullable(),
  /** rerun-sdk version that wrote the file. */
  rerun: z.string().nullable(),
});
export type ExportStatus = z.infer<typeof exportStatusSchema>;

export const exportStartRpc = defineRpc({
  name: "export.start",
  input: z.object({ root: z.string(), episode: z.number().int().min(0), quality: qualitySchema.default("preview") }),
  output: z.object({ exportId: z.string() }),
});

export const exportStatusRpc = defineRpc({
  name: "export.status",
  input: z.object({ exportId: z.string() }),
  output: exportStatusSchema,
});

export const READ_CHUNK_BYTES = 4 * 1024 * 1024;

export const exportReadRpc = defineRpc({
  name: "export.read",
  input: z.object({ exportId: z.string(), offset: z.number().int().min(0), length: z.number().int().min(1).max(READ_CHUNK_BYTES) }),
  output: z.instanceof(Uint8Array),
});

/** A page of a Parquet file, for the file panel. Values are display text. */
export const parquetPageSchema = z.object({
  numRows: z.number(),
  rowGroups: z.number(),
  offset: z.number(),
  columns: z.array(z.object({ name: z.string(), type: z.string() })),
  rows: z.array(z.array(z.string())),
  metadata: z.record(z.string(), z.string()),
});
export type ParquetPage = z.infer<typeof parquetPageSchema>;

/** Served by the host that has the file, which is the host of the workspace showing it. */
export const parquetReadRpc = defineRpc({
  name: "parquet.read",
  input: z.object({ path: z.string(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(1000).default(100) }),
  output: parquetPageSchema,
});

/**
 * Whether this host shows the dataset screen and sidebar. Hosts set up as dataset hosts by
 * scripts/install-host.sh only serve data, so the app always opens the screen on the computer it
 * runs on, where viewer addresses on localhost reach its browser tabs.
 */
export const hostRoleRpc = defineRpc({
  name: "host.role",
  input: z.object({}),
  output: z.object({ ui: z.boolean() }),
});

// Files of a connected folder. `root` is the connected folder; `path` is relative to it.

export const fileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(["file", "folder"]),
  size: z.number(),
  modifiedMs: z.number(),
});
export type FileEntry = z.infer<typeof fileEntrySchema>;

export const fileTextSchema = z.object({
  size: z.number(),
  modifiedMs: z.number(),
  binary: z.boolean(),
  /** Only the start of the file was read; it opens read-only. */
  truncated: z.boolean(),
  text: z.string(),
});
export type FileText = z.infer<typeof fileTextSchema>;

const inFolder = { ...target, root: z.string(), path: z.string() };

export const listFilesRpc = defineRpc({
  name: "files.list",
  input: z.object(inFolder),
  output: z.object({ path: z.string(), entries: z.array(fileEntrySchema), truncated: z.boolean() }),
});

export const readFileRpc = defineRpc({
  name: "files.read",
  input: z.object(inFolder),
  output: fileTextSchema,
});

export const writeFileRpc = defineRpc({
  name: "files.write",
  input: z.object({ ...inFolder, text: z.string(), expectedModifiedMs: z.number().nullable(), force: z.boolean().default(false) }),
  output: z.object({ modifiedMs: z.number(), size: z.number() }),
});

/** A page of a Parquet file inside a connected folder, from whichever host has it. */
export const readParquetRpc = defineRpc({
  name: "files.parquet",
  input: z.object({ ...inFolder, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(1000).default(100) }),
  output: parquetPageSchema,
});
