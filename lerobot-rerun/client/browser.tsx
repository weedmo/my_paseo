// The dataset screen. Without a connection it lists the connected folders, like a workspace list.
// With one it shows that folder's datasets and episodes. Episodes open as Rerun viewers in browser
// tabs of the "LeRobot Viewer" workspace on this host, or in the system browser off the desktop app.
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { openExternalUrl, useRpc, useSettings } from "@getpaseo/plugin/client";
import { FlatList, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  type Dataset,
  type Episode,
  type Session,
  listDatasetsRpc,
  listEpisodesRpc,
  listHostsRpc,
  openEpisodeRpc,
  sessionsRpc,
  stopRpc,
  viewerFocusRpc,
  viewerWorkspaceRpc,
} from "../shared/rpc";
import { type Connection, connectionSettings, tabSettings, viewerPreferences } from "../shared/settings";
import { FileTab, FileTree, fileName } from "./files";
import { FolderPicker, type NewConnection } from "./folder-picker";
import { Button, type Styles, datasetSummary, makeStyles, megabytes, message } from "./style";

const KEY = "lerobot-rerun";
const BUSY: Session["state"][] = ["preparing", "downloading", "starting"];
/** Datasets listed at once in the picker; the filter narrows the rest. */
const PICKER_LIMIT = 40;
/** A folder with more datasets than this is a batch of per-episode sources; list those last. */
const BATCH_SIZE = 20;

function parentOf(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}

/** Named datasets first, then those inside large batches, each by name. */
function rankDatasets(datasets: readonly Dataset[]): Dataset[] {
  const siblings = new Map<string, number>();
  for (const dataset of datasets) siblings.set(parentOf(dataset.path), (siblings.get(parentOf(dataset.path)) ?? 0) + 1);
  const batch = (dataset: Dataset) => ((siblings.get(parentOf(dataset.path)) ?? 0) > BATCH_SIZE ? 1 : 0);
  return [...datasets].sort((a, b) => batch(a) - batch(b) || a.name.localeCompare(b.name));
}

function episodeSummary(episode: Episode, fps: number): string {
  const parts = [`${episode.length} frames`];
  if (fps > 0) parts.push(`${(episode.length / fps).toFixed(1)} s`);
  for (const [key, value] of Object.entries(episode.extra)) {
    parts.push(`${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
  }
  return parts.join(" · ");
}

function sessionText(session: Session): string {
  const quality = session.quality === "original" ? " · original quality" : "";
  const name = `Episode ${session.episode} · ${session.root.split("/").pop()} · ${session.hostLabel}${quality}`;
  switch (session.state) {
    case "preparing":
      return `${name}: preparing${session.total > 0 ? ` (step ${Math.min(session.done + 1, session.total)} of ${session.total})` : ""}`;
    case "downloading":
      return `${name}: downloading ${megabytes(session.done)} of ${megabytes(session.total)}`;
    case "starting":
      return `${name}: starting the viewer`;
    case "ready":
      return session.total > 0 && session.done < session.total
        ? `${name}: loading cameras ${Math.round((100 * session.done) / session.total)}%`
        : name;
    case "error":
      return `${name}: failed`;
    default:
      return `${name}: stopped`;
  }
}

/** Connected folders, saved on this device. */
export function useConnections() {
  const state = useSettings(connectionSettings);
  const connections = state.status === "ready" ? state.values.connections : [];
  const save = async (next: Connection[]) => {
    if (state.status !== "ready") return false;
    return state.save({ ...state.values, connections: next }, state.revision);
  };
  return { ready: state.status === "ready", connections, save };
}

export function connectionLabel(connection: Connection): string {
  return connection.serverId ? `${connection.name} · ${connection.hostLabel}` : connection.name;
}

/** The viewer page was opened as a Paseo tab during this app session. */
let viewerPageOpened = false;

/**
 * Shows a viewer. All viewers live as tabs inside one viewer page, so a viewer that is already open
 * is switched to instead of opening another Paseo tab. In the desktop app the page is a browser tab
 * of the shared "viewer" workspace; elsewhere it opens in the system browser.
 */
function useShowViewer(props: PluginSurfaceProps) {
  const toast = useToast();
  const focus = useRpc(viewerFocusRpc);
  const viewerWorkspace = useRpc(viewerWorkspaceRpc);
  const workspace = useRef<Promise<string> | null>(null);
  const navigation = props.navigation;
  const openBrowser = navigation?.openBrowser;
  const workspaceId = () => {
    workspace.current ??= viewerWorkspace({}).then((result) => result.workspaceId);
    workspace.current.catch(() => {
      workspace.current = null;
    });
    return workspace.current;
  };
  return {
    inPaseo: Boolean(openBrowser),
    show: async (session: Session) => {
      try {
        const page = await focus({ id: session.id });
        if (!openBrowser || !navigation) {
          if (!page.alive) await openExternalUrl(page.url);
          return;
        }
        const id = await workspaceId();
        const target = { workspaceId: id, serverId: props.host.id };
        if (page.alive) {
          navigation.openWorkspace(target);
          return;
        }
        if (viewerPageOpened) {
          // The page may only be paused while its workspace is hidden: show it and wait for it.
          navigation.openWorkspace(target);
          for (let i = 0; i < 6; i++) {
            await new Promise((done) => setTimeout(done, 500));
            if ((await focus({ id: session.id })).alive) return;
          }
        }
        openBrowser({ url: page.url, ...target });
        viewerPageOpened = true;
      } catch (error) {
        toast.error(message(error));
      }
    },
  };
}

function Viewers({ styles, sessions, max, onShow, onStop, inPaseo }: {
  styles: Styles;
  sessions: readonly Session[];
  max: number;
  onShow: (session: Session) => void;
  onStop: (id: string) => void;
  inPaseo: boolean;
}) {
  if (sessions.length === 0) return null;
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.h2}>Open viewers ({sessions.length} of {max})</Text>
      {sessions.map((session) => (
        <View key={session.id} style={session.state === "ready" ? styles.cardActive : styles.card}>
          <View style={styles.spread}>
            <Text style={[styles.text, { flex: 1 }]} numberOfLines={1}>{sessionText(session)}</Text>
            <View style={styles.row}>
              {session.url ? (
                <Button styles={styles} primary label="Show" onPress={() => onShow(session)} />
              ) : null}
              <Button styles={styles} label={BUSY.includes(session.state) ? "Cancel" : "Stop"} onPress={() => onStop(session.id)} />
            </View>
          </View>
          {session.message ? <Text style={session.state === "error" ? styles.danger : styles.muted}>{session.message}</Text> : null}
        </View>
      ))}
      {sessions.length >= max ? <Text style={styles.muted}>Opening another episode closes the oldest viewer and its tab.</Text> : null}
    </View>
  );
}

/** What the sidebar asked the screen to do; `nonce` changes on every click. */
export interface ScreenRequest {
  dataset?: string;
  episode?: number;
  connect?: boolean;
  nonce?: string;
}

export function DatasetBrowser(props: PluginSurfaceProps & {
  /** Show this connection; without it the screen lists all connections. */
  connectionId?: string;
  request?: ScreenRequest;
  /** Opens a connection or, with null, the connection list. */
  onNavigate: (connectionId: string | null) => void;
}) {
  const { theme, layout, connectionId, onNavigate } = props;
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
  const toast = useToast();
  const queryClient = useQueryClient();
  const { ready, connections, save } = useConnections();
  const listHosts = useRpc(listHostsRpc);
  const readSessions = useRpc(sessionsRpc);
  const stopViewer = useRpc(stopRpc);
  const { show, inPaseo } = useShowViewer(props);
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    if (props.request?.connect) setPicking(true);
  }, [props.request?.nonce]);

  const hosts = useQuery({ queryKey: [KEY, "hosts"], queryFn: () => listHosts({}), refetchInterval: 15_000 }).data?.hosts ?? [];
  const sessionsQuery = useQuery({
    queryKey: [KEY, "sessions"],
    queryFn: () => readSessions({}),
    refetchInterval: (query) => (query.state.data?.sessions.some((s) => BUSY.includes(s.state)) ? 500 : 5000),
  });
  const sessions = sessionsQuery.data?.sessions ?? [];
  const refreshSessions = () => queryClient.invalidateQueries({ queryKey: [KEY, "sessions"] });
  const stop = useMutation({ mutationFn: (id: string) => stopViewer({ id }), onSettled: refreshSessions });

  const connection = connections.find((entry) => entry.id === connectionId) ?? null;

  const addConnection = async (next: NewConnection) => {
    const existing = connections.find((entry) => entry.serverId === next.serverId && entry.path === next.path);
    if (existing) return onNavigate(existing.id);
    const created: Connection = { ...next, id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` };
    if (!(await save([...connections, created]))) return toast.error("Could not save the connection.");
    onNavigate(created.id);
  };
  const removeConnection = async (id: string) => {
    await save(connections.filter((entry) => entry.id !== id));
    if (id === connectionId) onNavigate(null);
  };

  const viewers = (
    <Viewers
      styles={styles}
      sessions={sessions}
      max={sessionsQuery.data?.max ?? 4}
      onShow={(session) => void show(session)}
      onStop={(id) => stop.mutate(id)}
      inPaseo={inPaseo}
    />
  );

  if (connectionId && ready && !connection) {
    return (
      <View style={styles.screen}>
        <Text style={styles.muted}>This connection was removed.</Text>
        <Button styles={styles} label="All datasets" onPress={() => onNavigate(null)} />
      </View>
    );
  }
  if (connection) {
    return (
      <ConnectionView
        {...props}
        styles={styles}
        connection={connection}
        viewers={viewers}
        sessions={sessions}
        onShow={show}
        onRemove={() => void removeConnection(connection.id)}
        onSessionsChanged={refreshSessions}
      />
    );
  }

  return (
    <View style={styles.screen}>
      <FolderPicker
        styles={styles}
        open={picking}
        onOpenChange={setPicking}
        hosts={hosts}
        initialServerId={null}
        onConnect={(next) => void addConnection(next)}
      />
      <FlatList
        data={connections}
        keyExtractor={(entry) => entry.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View style={styles.section}>
            <View style={styles.spread}>
              <Text style={styles.h1}>LeRobot datasets</Text>
              <Button styles={styles} primary label="Connect folder" onPress={() => setPicking(true)} />
            </View>
            {ready && connections.length === 0 ? (
              <View style={styles.card}>
                <Text style={styles.text}>No dataset folder is connected yet.</Text>
                <Text style={styles.muted}>
                  Connect a LeRobot dataset folder, or a folder that holds several, on this computer or a connected host.
                  Connected folders appear here and in the sidebar.
                </Text>
              </View>
            ) : null}
            {viewers}
            {connections.length > 0 ? <Text style={styles.h2}>Connected folders</Text> : null}
          </View>
        }
        renderItem={({ item }) => {
          const host = hosts.find((h) => (item.serverId ? h.serverId === item.serverId : h.self));
          const status = host && host.status !== "online" ? ` (${host.status})` : "";
          return (
            <View style={[styles.card, styles.spread]}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open ${item.name}`}
                onPress={() => onNavigate(item.id)}
                style={{ flex: 1, gap: 2 }}
              >
                <Text style={styles.title} numberOfLines={1}>{item.name}</Text>
                <Text style={styles.muted} numberOfLines={1}>
                  {item.hostLabel}{status} · {item.kind === "dataset" ? "dataset" : "folder of datasets"}
                </Text>
                <Text style={styles.muted} numberOfLines={1}>{item.path}</Text>
              </Pressable>
              <Button styles={styles} label="Disconnect" accessibilityLabel={`Disconnect ${item.name}`} onPress={() => void removeConnection(item.id)} />
            </View>
          );
        }}
      />
    </View>
  );
}

/** The Episodes tab: datasets, quality, open viewers and the episode list of one connection. */
function EpisodesPane(props: PluginSurfaceProps & {
  request?: ScreenRequest;
  styles: Styles;
  connection: Connection;
  viewers: ReactNode;
  sessions: readonly Session[];
  onShow: (session: Session) => Promise<void>;
  onRemove: () => void;
  onSessionsChanged: () => void;
  onNavigate: (connectionId: string | null) => void;
}) {
  const { styles, connection, viewers, sessions, onShow, onSessionsChanged, layout } = props;
  const toast = useToast();
  const queryClient = useQueryClient();
  const listDatasets = useRpc(listDatasetsRpc);
  const listEpisodes = useRpc(listEpisodesRpc);
  const openEpisode = useRpc(openEpisodeRpc);
  const preferences = useSettings(viewerPreferences);
  const quality = preferences.status === "ready" ? preferences.values.quality : "preview";
  const setQuality = (next: "preview" | "original") => {
    if (preferences.status === "ready") void preferences.save({ ...preferences.values, quality: next }, preferences.revision);
  };
  const target = connection.serverId || undefined;
  const forceRefresh = useRef(false);
  const [root, setRoot] = useState<string | null>(connection.kind === "dataset" ? connection.path : null);
  const [datasetFilter, setDatasetFilter] = useState("");
  const [filter, setFilter] = useState("");
  /** The viewer that opens by itself once it is ready. */
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    setRoot(props.request?.dataset ?? (connection.kind === "dataset" ? connection.path : null));
    setFilter("");
    setDatasetFilter("");
  }, [connection.id, props.request?.dataset]);

  const datasets = useQuery({
    queryKey: [KEY, "datasets", connection.serverId, connection.path],
    queryFn: () => {
      const refresh = forceRefresh.current;
      forceRefresh.current = false;
      return listDatasets({ serverId: target, roots: [connection.path], only: true, refresh });
    },
    staleTime: 60_000,
  });
  const found = useMemo(() => rankDatasets(datasets.data?.datasets ?? []), [datasets.data]);
  const selected = found.find((dataset) => dataset.path === root) ?? null;
  useEffect(() => {
    if (!selected && found.length === 1) setRoot(found[0].path);
  }, [selected, found]);
  const matching = useMemo(() => {
    const words = datasetFilter.toLowerCase().split(/\s+/).filter(Boolean);
    return words.length === 0 ? found : found.filter((dataset) => words.every((word) => dataset.name.toLowerCase().includes(word)));
  }, [found, datasetFilter]);

  const episodes = useQuery({
    queryKey: [KEY, "episodes", connection.serverId, selected?.path],
    queryFn: () => listEpisodes({ serverId: target, root: (selected as Dataset).path }),
    enabled: selected !== null,
    staleTime: 60_000,
    // The host may be installing its Python environment; it finishes by itself.
    refetchInterval: (query) => (query.state.error && message(query.state.error).includes("Setting up") ? 5000 : false),
    retry: false,
  });
  const visible = useMemo(() => {
    const all = episodes.data?.episodes ?? [];
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return all;
    return all.filter((episode) => {
      const text = `#${episode.index} ${episode.tasks.join(" ")} ${JSON.stringify(episode.extra)}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }, [episodes.data, filter]);

  // Open the viewer once the episode that was clicked becomes ready.
  useEffect(() => {
    const session = sessions.find((s) => s.id === pending);
    if (!session) return;
    if (session.state === "ready" && session.url) {
      setPending(null);
      void onShow(session);
    } else if (session.state === "error" || session.state === "stopped") {
      setPending(null);
      if (session.state === "error") toast.error(session.message ?? "The viewer failed.");
    }
  }, [sessions, pending]);

  const open = useMutation({
    mutationFn: (episode: number) => openEpisode({ serverId: target, root: (selected as Dataset).path, episode, quality }),
    onSuccess: (session) => {
      if (session.state === "ready" && session.url) void onShow(session);
      else setPending(session.id);
    },
    onError: (error) => toast.error(message(error)),
    onSettled: onSessionsChanged,
  });
  // An episode picked in the sidebar opens once its dataset is loaded here.
  const handled = useRef<string | null>(null);
  useEffect(() => {
    const request = props.request;
    if (request?.episode === undefined || !request.nonce || handled.current === request.nonce) return;
    if (!selected || (request.dataset && selected.path !== request.dataset)) return;
    handled.current = request.nonce;
    const live = sessionFor(request.episode);
    if (live?.state === "ready" && live.url) void onShow(live);
    else open.mutate(request.episode);
  }, [props.request?.nonce, selected?.path]);

  const sessionFor = (episode: number) =>
    sessions.find((s) => s.root === selected?.path && s.episode === episode && s.quality === quality && s.state !== "stopped") ?? null;

  const header = (
    <View style={styles.section}>
      <View style={styles.row}>
        {(["preview", "original"] as const).map((option) => (
          <Pressable
            key={option}
            accessibilityRole="button"
            accessibilityLabel={option === "preview" ? "Smooth preview video" : "Original quality video"}
            accessibilityState={{ selected: quality === option }}
            onPress={() => setQuality(option)}
            style={quality === option ? styles.chipActive : styles.chip}
          >
            <Text style={quality === option ? styles.chipTextActive : styles.chipText}>
              {option === "preview" ? "Smooth preview" : "Original quality"}
            </Text>
          </Pressable>
        ))}
        <Text style={[styles.muted, { flex: 1 }]}>
          {quality === "preview"
            ? "Small video that plays smoothly on any computer; cached on the dataset host."
            : "The dataset's own video. Heavy for long, high-resolution episodes."}
        </Text>
        <Button
          styles={styles}
          label={datasets.isFetching ? "Refreshing…" : "Refresh"}
          onPress={() => {
            forceRefresh.current = true;
            void datasets.refetch();
            void queryClient.invalidateQueries({ queryKey: [KEY, "episodes", connection.serverId] });
          }}
        />
      </View>

      {viewers}

      {datasets.isFetching && !datasets.data ? (
        <Text style={styles.muted}>Looking for datasets in this folder. Network drives can take up to 20 seconds.</Text>
      ) : null}
      {datasets.error ? <Text style={styles.danger}>{message(datasets.error)}</Text> : null}
      {(datasets.data?.errors ?? []).map((error) => (
        <Text key={error} style={styles.muted}>{error}</Text>
      ))}
      {datasets.isSuccess && found.length === 0 ? <Text style={styles.muted}>No LeRobot dataset in this folder.</Text> : null}

      {selected ? (
        found.length > 1 ? (
          <View style={styles.cardActive}>
            <View style={styles.spread}>
              <Text style={[styles.title, { flex: 1 }]} numberOfLines={1}>{selected.name}</Text>
              <Button styles={styles} label="Change" onPress={() => setRoot(null)} />
            </View>
            <Text style={styles.muted} numberOfLines={1}>{datasetSummary(selected)}</Text>
          </View>
        ) : (
          <Text style={styles.muted} numberOfLines={1}>{datasetSummary(selected)}</Text>
        )
      ) : found.length > 0 ? (
        <View style={{ gap: 6 }}>
          <View style={styles.row}>
            <TextInput
              style={styles.input}
              value={datasetFilter}
              onChangeText={setDatasetFilter}
              placeholder="Filter datasets by name"
              placeholderTextColor={styles.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Dataset filter"
            />
            <Text style={styles.muted}>
              {matching.length > PICKER_LIMIT ? `first ${PICKER_LIMIT} of ` : ""}
              {matching.length} of {found.length} datasets
            </Text>
          </View>
          {matching.slice(0, PICKER_LIMIT).map((dataset) => (
            <Pressable
              key={dataset.path}
              accessibilityRole="button"
              accessibilityLabel={`Dataset ${dataset.name}`}
              onPress={() => setRoot(dataset.path)}
              style={styles.listRow}
            >
              <Text style={styles.text} numberOfLines={1}>{dataset.name}</Text>
              <Text style={styles.muted} numberOfLines={1}>{datasetSummary(dataset)}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {selected ? (
        <View style={styles.row}>
          <TextInput
            style={styles.input}
            value={filter}
            onChangeText={setFilter}
            placeholder="Filter episodes by number, task or metadata"
            placeholderTextColor={styles.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Episode filter"
          />
          <Text style={styles.muted}>
            {episodes.isLoading ? "Loading episodes…" : `${visible.length} of ${episodes.data?.episodes.length ?? 0} episodes`}
          </Text>
        </View>
      ) : null}
      {episodes.error ? <Text style={styles.danger}>{message(episodes.error)}</Text> : null}
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={selected ? visible : []}
        keyExtractor={(episode) => String(episode.index)}
        ListHeaderComponent={header}
        contentContainerStyle={[styles.list, { gap: layout.compact ? 6 : 8 }]}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => {
          const session = sessionFor(item.index);
          const busy = session !== null && BUSY.includes(session.state);
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open episode ${item.index} in Rerun`}
              disabled={open.isPending}
              onPress={() => (session?.state === "ready" && session.url ? void onShow(session) : open.mutate(item.index))}
              style={session ? styles.cardActive : styles.card}
            >
              <View style={styles.spread}>
                <Text style={styles.title}>Episode {item.index}</Text>
                <Text style={styles.muted}>{busy ? "Preparing…" : session?.state === "ready" ? "Open" : ""}</Text>
              </View>
              {item.tasks.length > 0 ? <Text style={styles.text} numberOfLines={2}>{item.tasks.join(" / ")}</Text> : null}
              <Text style={styles.muted} numberOfLines={2}>{episodeSummary(item, selected?.fps ?? 0)}</Text>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const EPISODES_TAB = "episodes";
const fileTab = (path: string) => `file:${path}`;

/**
 * One connection, used like a workspace: a header, its own tabs (Episodes and open files), the
 * folder's file tree, and the active tab. Tabs are remembered per connection on this device.
 */
function ConnectionView(props: PluginSurfaceProps & {
  request?: ScreenRequest;
  styles: Styles;
  connection: Connection;
  viewers: ReactNode;
  sessions: readonly Session[];
  onShow: (session: Session) => Promise<void>;
  onRemove: () => void;
  onSessionsChanged: () => void;
  onNavigate: (connectionId: string | null) => void;
}) {
  const { styles, connection, onRemove, onNavigate, layout, theme } = props;
  const tabState = useSettings(tabSettings);
  const saved = tabState.status === "ready" ? tabState.values.byConnection[connection.id] : undefined;
  const tabs = saved?.tabs.length ? saved.tabs : [EPISODES_TAB];
  const active = saved && tabs.includes(saved.active) ? saved.active : EPISODES_TAB;
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [closing, setClosing] = useState<string | null>(null);
  const [treeOpen, setTreeOpen] = useState(!layout.compact);

  const saveTabs = (next: string[], nextActive: string) => {
    if (tabState.status !== "ready") return;
    const list = next.includes(EPISODES_TAB) ? next : [EPISODES_TAB, ...next];
    void tabState.save(
      { ...tabState.values, byConnection: { ...tabState.values.byConnection, [connection.id]: { tabs: list, active: nextActive } } },
      tabState.revision,
    );
  };
  const openFile = (path: string) => {
    const id = fileTab(path);
    saveTabs(tabs.includes(id) ? tabs : [...tabs, id], id);
    if (layout.compact) setTreeOpen(false);
  };
  const closeTab = (id: string, force = false) => {
    if (dirty[id] && !force) {
      setClosing(id);
      return;
    }
    setClosing(null);
    const next = tabs.filter((tab) => tab !== id);
    const index = tabs.indexOf(id);
    saveTabs(next, active === id ? next[Math.max(0, index - 1)] ?? EPISODES_TAB : active);
    setDirty((current) => ({ ...current, [id]: false }));
  };
  // The sidebar opens episodes through the screen: show the Episodes tab for them.
  useEffect(() => {
    if (props.request?.episode !== undefined && active !== EPISODES_TAB) saveTabs(tabs, EPISODES_TAB);
  }, [props.request?.nonce]);

  const c = theme.colors;
  const tabStyle = (on: boolean) => ({
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderTopLeftRadius: 6,
    borderTopRightRadius: 6,
    borderBottomWidth: 2,
    borderColor: on ? c.accent : "transparent",
    backgroundColor: on ? c.surface1 : "transparent",
  });

  return (
    <View style={[styles.screen, { gap: 8 }]}>
      <View style={styles.spread}>
        <View style={{ flex: 1, gap: 2 }}>
          <Pressable accessibilityRole="link" accessibilityLabel="All datasets" onPress={() => onNavigate(null)}>
            <Text style={styles.muted}>‹ All datasets</Text>
          </Pressable>
          <Text style={styles.h1} numberOfLines={1}>{connection.name}</Text>
          <Text style={styles.muted} numberOfLines={1}>{connection.hostLabel} · {connection.path}</Text>
        </View>
        <View style={styles.row}>
          <Button styles={styles} label={treeOpen ? "Hide files" : "Files"} onPress={() => setTreeOpen(!treeOpen)} />
          <Button
            styles={styles}
            label={confirmingRemove ? "Yes, disconnect" : "Disconnect"}
            primary={confirmingRemove}
            onPress={() => (confirmingRemove ? onRemove() : setConfirmingRemove(true))}
          />
          {confirmingRemove ? <Button styles={styles} label="Cancel" onPress={() => setConfirmingRemove(false)} /> : null}
        </View>
      </View>
      {confirmingRemove ? (
        <Text style={styles.danger}>
          Disconnecting removes this folder from the list and the sidebar. The files on {connection.hostLabel} are not touched; connect it again any time.
        </Text>
      ) : null}

      <ScrollView horizontal contentContainerStyle={{ gap: 2 }} style={{ flexGrow: 0, borderBottomWidth: 1, borderColor: c.border }}>
        {tabs.map((id) => {
          const on = id === active;
          const label = id === EPISODES_TAB ? "Episodes" : fileName(id.slice(5));
          return (
            <View key={id} style={tabStyle(on)}>
              <Pressable accessibilityRole="tab" accessibilityLabel={`Show ${label}`} accessibilityState={{ selected: on }} onPress={() => saveTabs(tabs, id)}>
                <Text style={on ? styles.title : styles.text} numberOfLines={1}>
                  {dirty[id] ? "● " : ""}
                  {label}
                </Text>
              </Pressable>
              {id === EPISODES_TAB ? null : (
                <Pressable accessibilityRole="button" accessibilityLabel={`Close ${label}`} onPress={() => closeTab(id)} hitSlop={6}>
                  <Text style={styles.muted}>✕</Text>
                </Pressable>
              )}
            </View>
          );
        })}
      </ScrollView>
      {closing ? (
        <View style={[styles.card, styles.spread]}>
          <Text style={[styles.danger, { flex: 1 }]}>{fileName(closing.slice(5))} has unsaved changes.</Text>
          <Button styles={styles} label="Close without saving" onPress={() => closeTab(closing, true)} />
          <Button styles={styles} label="Keep open" onPress={() => setClosing(null)} />
        </View>
      ) : null}

      <View style={{ flex: 1, flexDirection: layout.compact ? "column" : "row", gap: 12 }}>
        {treeOpen ? (
          <View style={layout.compact ? { maxHeight: 320 } : { width: 280, borderRightWidth: 1, borderColor: c.border, paddingRight: 8 }}>
            <FileTree
              connection={connection}
              styles={styles}
              theme={theme}
              activePath={active.startsWith("file:") ? active.slice(5) : null}
              onOpenFile={openFile}
            />
          </View>
        ) : null}
        <View style={{ flex: 1 }}>
          {/* Every open tab stays mounted, so edits survive switching tabs. */}
          {tabs.map((id) => (
            <View key={id} style={{ flex: 1, display: id === active ? "flex" : "none" }}>
              {id === EPISODES_TAB ? (
                <EpisodesPane {...props} />
              ) : (
                <FileTab
                  connection={connection}
                  path={id.slice(5)}
                  styles={styles}
                  theme={theme}
                  onDirty={(value) => setDirty((current) => (current[id] === value ? current : { ...current, [id]: value }))}
                />
              )}
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}
