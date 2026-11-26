import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { expandHome, findDatasets } from "./server/datasets";
import { Exports } from "./server/exports";
import { Python } from "./server/python";
import { Remote } from "./server/remote";
import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { listFiles, readFileText, writeFileText } from "./server/files";
import { ViewerHub } from "./server/hub";
import { listFolder } from "./server/folders";
import { Viewer, ViewerPool } from "./server/session";
import {
  type Host,
  datasetSchema,
  episodeSchema,
  folderListingSchema,
  exportReadRpc,
  exportStartRpc,
  exportStatusRpc,
  listDatasetsRpc,
  listEpisodesRpc,
  listFolderRpc,
  listHostsRpc,
  openEpisodeRpc,
  sessionsRpc,
  stopRpc,
  fileEntrySchema,
  fileTextSchema,
  hostRoleRpc,
  listFilesRpc,
  readFileRpc,
  readParquetRpc,
  writeFileRpc,
  parquetPageSchema,
  parquetReadRpc,
  viewerFocusRpc,
  viewerServeRpc,
  viewerWorkspaceRpc,
} from "./shared/rpc";
import { DEFAULT_SETTINGS, type ViewerSettings, viewerSettings } from "./shared/settings";

/**
 * The address in a host's connection description, such as `ssh://192.0.2.10 (daemon port 6767)`
 * or `tcp://192.0.2.20:6767`. Relay connections have none: the app cannot reach those hosts directly.
 */
function hostAddress(description: string): string | null {
  const match = /^(?:ssh|tcp|wss?|https?):\/\/(?:[^@/\s]*@)?(\[[^\]]+\]|[^:/\s]+)/.exec(description);
  return match ? match[1] : null;
}

/** Dataset searches are reused this long; the Refresh button skips the cache. */
const SEARCH_CACHE_MS = 5 * 60_000;
/** Viewers kept at once on this host; each holds its episode in memory. */
const MAX_VIEWERS = 4;
const VIEWER_WORKSPACE_DIR = join(homedir(), ".local", "share", "paseo-lerobot-rerun", "viewer");
/** Present on hosts that only serve data to another computer's app; see scripts/install-host.sh. */
const DATA_HOST_MARKER = join(homedir(), ".local", "share", "paseo-lerobot-rerun", "data-host");
const VIEWER_WORKSPACE_README = `# LeRobot Viewer

Paseo opens LeRobot episodes from the lerobot-rerun plugin as browser tabs in this workspace.
The folder only gives the workspace a home; it holds no data and can be left empty.
`;

export default function contribute(server: PluginServerContext) {
  const store = server.registerSettings(viewerSettings);
  const settings = async (): Promise<ViewerSettings> => {
    const state = await store.read();
    return state.status === "ready" ? state.values : DEFAULT_SETTINGS;
  };
  const python = new Python();
  const exports = new Exports(python);
  const remote = new Remote();
  const viewer = new ViewerPool(() => new Viewer(python, exports, remote), MAX_VIEWERS);
  // Viewers opened for this computer's app, as tabs of one page.
  const hub = new ViewerHub(
    () =>
      viewer
        .list()
        .filter((s) => s.title !== null && s.state !== "error")
        .map((s) => ({ id: s.id, title: s.title as string, url: s.state === "ready" ? s.url : null, state: s.state })),
    (id) => void viewer.stop(id),
  );

  /** This host and the hosts registered on it. */
  const hosts = async (paseo: PaseoApi): Promise<{ hosts: Host[]; error: string | null }> => {
    const directory = await paseo.hosts.list();
    const list: Host[] = [
      { serverId: directory.self.serverId, label: directory.self.label, self: true, status: "online", error: null, address: null },
    ];
    for (const host of directory.hosts) {
      if (!host.serverId || host.serverId === directory.self.serverId) continue;
      list.push({
        serverId: host.serverId,
        label: host.label ?? host.targetDescription,
        self: false,
        status: host.status,
        error: host.error?.message ?? null,
        address: hostAddress(host.targetDescription),
      });
    }
    return { hosts: list, error: null };
  };

  /** Resolves a target host: null for this one, or a label for a remote one. */
  const target = async (paseo: PaseoApi, serverId: string | undefined) => {
    const { hosts: list } = await hosts(paseo);
    const self = list[0];
    if (!serverId || serverId === self.serverId) return { self, remote: null };
    const host = list.find((entry) => entry.serverId === serverId);
    if (!host) throw new Error("That host is no longer registered on this daemon.");
    if (host.status !== "online") throw new Error(`${host.label} is ${host.status}.`);
    return { self, remote: host };
  };

  server.handle(listHostsRpc, async (_input, { paseo }) => {
    try {
      return await hosts(paseo);
    } catch (error) {
      // Daemons without connected hosts still serve their own datasets.
      const self: Host = { serverId: "", label: "This host", self: true, status: "online", error: null, address: null };
      return { hosts: [self], error: error instanceof Error ? error.message : String(error) };
    }
  });

  const searches = new Map<string, { at: number; result: Promise<Awaited<ReturnType<typeof findDatasets>>> }>();
  server.handle(listDatasetsRpc, async ({ serverId, roots, refresh, only }, { paseo }) => {
    const { remote: host } = await target(paseo, serverId);
    if (host) {
      const result = (await remote.call(host.serverId, host.label, "datasets.list", { roots, refresh, only })) as {
        datasets: unknown;
        errors: string[];
        searchedAt?: number;
      };
      return {
        datasets: datasetSchema.array().parse(result.datasets),
        errors: result.errors,
        searchedAt: result.searchedAt ?? Date.now(),
      };
    }
    const all = [...new Set([...(only ? [] : (await settings()).roots), ...roots])];
    const key = JSON.stringify(all);
    let entry = searches.get(key);
    if (refresh || !entry || Date.now() - entry.at > SEARCH_CACHE_MS) {
      entry = { at: Date.now(), result: findDatasets(all) };
      searches.set(key, entry);
      entry.result.catch(() => searches.delete(key));
    }
    return { ...(await entry.result), searchedAt: entry.at };
  });

  server.handle(listEpisodesRpc, async ({ serverId, root }, { paseo }) => {
    const { remote: host } = await target(paseo, serverId);
    if (host) {
      const result = (await remote.call(host.serverId, host.label, "episodes.list", { root })) as { episodes: unknown };
      return { episodes: episodeSchema.array().parse(result.episodes) };
    }
    const result = await python.json((await settings()).pythonPath, ["episodes", "--root", expandHome(root)]);
    return { episodes: episodeSchema.array().parse(result.episodes) };
  });

  server.handle(openEpisodeRpc, async ({ serverId, root, episode, quality }, { paseo }) => {
    const { self, remote: host } = await target(paseo, serverId);
    const { pythonPath, viewerHost } = await settings();
    return viewer.open({
      serverId: host?.serverId ?? null,
      selfServerId: self.serverId,
      hostLabel: (host ?? self).label,
      root: host ? root : expandHome(root),
      episode,
      quality,
      pythonSetting: pythonPath,
      viewerHost: viewerHost.trim(),
      address: host?.address ?? null,
      title: `Episode ${episode} · ${basename(root.replace(/\/+$/, ""))}`,
    });
  });
  // Called by a viewer host for a dataset here: serve it live, reachable at the caller's address for us.
  server.handle(viewerServeRpc, async ({ root, episode, host, quality }, { paseo }) => {
    const { self } = await target(paseo, undefined);
    return viewer.open({
      serverId: null,
      selfServerId: self.serverId,
      hostLabel: self.label,
      root: expandHome(root),
      episode,
      quality,
      pythonSetting: (await settings()).pythonPath,
      viewerHost: host,
      address: null,
      title: null,
    });
  });
  server.handle(listFolderRpc, async ({ serverId, path }, { paseo }) => {
    const { remote: host } = await target(paseo, serverId);
    if (host) return folderListingSchema.parse(await remote.call(host.serverId, host.label, "folders.list", { path }));
    return listFolder(path);
  });

  // Files of a connected folder, on this host or relayed to the host that has them.
  server.handle(listFilesRpc, async ({ serverId, root, path }, { paseo }) => {
    const { remote: host } = await target(paseo, serverId);
    if (host) {
      const result = (await remote.call(host.serverId, host.label, "files.list", { root, path })) as { path: string; entries: unknown; truncated: boolean };
      return { path: result.path, entries: fileEntrySchema.array().parse(result.entries), truncated: result.truncated };
    }
    return listFiles(root, path);
  });
  server.handle(readFileRpc, async ({ serverId, root, path }, { paseo }) => {
    const { remote: host } = await target(paseo, serverId);
    if (host) return fileTextSchema.parse(await remote.call(host.serverId, host.label, "files.read", { root, path }));
    return readFileText(root, path);
  });
  server.handle(writeFileRpc, async ({ serverId, root, path, text, expectedModifiedMs, force }, { paseo }) => {
    const { remote: host } = await target(paseo, serverId);
    if (host) {
      return (await remote.call(host.serverId, host.label, "files.write", { root, path, text, expectedModifiedMs, force })) as {
        modifiedMs: number;
        size: number;
      };
    }
    return writeFileText(root, path, text, expectedModifiedMs, force);
  });
  server.handle(readParquetRpc, async ({ serverId, root, path, offset, limit }, { paseo }) => {
    const { remote: host } = await target(paseo, serverId);
    if (host) return parquetPageSchema.parse(await remote.call(host.serverId, host.label, "files.parquet", { root, path, offset, limit }));
    const full = resolve(expandHome(root), path);
    const rel = relative(resolve(expandHome(root)), full);
    if (rel.startsWith("..")) throw new Error("That path is outside the connected folder.");
    const page = await python.json((await settings()).pythonPath, ["parquet", "--path", full, "--offset", String(offset), "--limit", String(limit)]);
    return parquetPageSchema.parse(page);
  });

  server.handle(hostRoleRpc, async () => ({
    ui: await access(DATA_HOST_MARKER).then(
      () => false,
      () => true,
    ),
  }));

  server.handle(parquetReadRpc, async ({ path, offset, limit }) => {
    const page = await python.json((await settings()).pythonPath, ["parquet", "--path", path, "--offset", String(offset), "--limit", String(limit)]);
    return parquetPageSchema.parse(page);
  });

  server.handle(viewerFocusRpc, async ({ id }) => hub.focus(id));

  server.handle(sessionsRpc, async () => ({ sessions: viewer.list(), max: viewer.max }));
  server.handle(stopRpc, async ({ id }) => {
    await viewer.stop(id);
    return { ok: true as const };
  });

  let viewerWorkspace: Promise<{ workspaceId: string; directory: string }> | null = null;
  server.handle(viewerWorkspaceRpc, async (_input, { paseo }) => {
    viewerWorkspace ??= (async () => {
      await mkdir(VIEWER_WORKSPACE_DIR, { recursive: true });
      await writeFile(join(VIEWER_WORKSPACE_DIR, "README.md"), VIEWER_WORKSPACE_README, "utf8");
      const workspace = await paseo.workspaces.open(VIEWER_WORKSPACE_DIR);
      return { workspaceId: workspace.id, directory: VIEWER_WORKSPACE_DIR };
    })();
    viewerWorkspace.catch(() => {
      viewerWorkspace = null;
    });
    return viewerWorkspace;
  });

  // Called by a viewer host, possibly this one, for datasets on this host.
  server.handle(exportStartRpc, async ({ root, episode, quality }) => {
    const entry = await exports.start(expandHome(root), episode, quality, (await settings()).pythonPath);
    return { exportId: entry.id };
  });
  server.handle(exportStatusRpc, async ({ exportId }) => exports.status(exportId));
  server.handle(exportReadRpc, async ({ exportId, offset, length }) => exports.read(exportId, offset, length));

  return async () => {
    // Viewers that remote hosts serve for us would otherwise keep running there.
    hub.stop();
    await Promise.race([viewer.stop(), new Promise((done) => setTimeout(done, 3000))]);
    exports.stop();
    await remote.close();
    await python.cleanup();
  };
}
