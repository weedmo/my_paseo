// The sidebar tree: "LeRobot datasets" toggles the connected folders, each folder shows its
// episodes (or its datasets, then their episodes), and an episode opens its viewer.
import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type Dataset, type Episode, type Session, listDatasetsRpc, listEpisodesRpc, sessionsRpc } from "../shared/rpc";
import { type Connection, sidebarSettings } from "../shared/settings";
import { connectionLabel, useConnections } from "./browser";

export const SCREEN = "datasets";
const KEY = "lerobot-rerun";
/** Episodes listed under a dataset; the rest are one click away on the dataset screen. */
const EPISODE_ROWS = 20;
const DATASET_ROWS = 10;

function Chevron({ open, onPress, color, label }: { open: boolean; onPress: () => void; color: string; label: string }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={8} style={{ paddingHorizontal: 6 }}>
      <Text style={{ color, fontSize: 12 }}>{open ? "▾" : "▸"}</Text>
    </Pressable>
  );
}

/** One short line; the task text is on the dataset screen. */
function episodeLabel(episode: Episode, fps: number): string {
  const seconds = fps > 0 ? ` · ${Math.round(episode.length / fps)}s` : ` · ${episode.length} frames`;
  return `Episode ${episode.index}${seconds}`;
}

function sessionIcon(session: Session | undefined): string {
  if (!session) return "Play";
  return session.state === "ready" ? "MonitorPlay" : "LoaderCircle";
}

/** Episode rows for one dataset, then a row that opens the full list. */
function EpisodeRows(props: {
  connection: Connection;
  dataset: { path: string; fps: number };
  sessions: readonly Session[];
  current: Record<string, string> | null;
  openScreen: PluginSidebarItemProps["openScreen"];
}) {
  const { connection, dataset, sessions, current, openScreen } = props;
  const listEpisodes = useRpc(listEpisodesRpc);
  const episodes = useQuery({
    queryKey: [KEY, "episodes", connection.serverId, dataset.path],
    queryFn: () => listEpisodes({ serverId: connection.serverId || undefined, root: dataset.path }),
    staleTime: 60_000,
  });
  const rows: ReactNode[] = [];
  const params = (extra: Record<string, string>) => ({ c: connection.id, d: dataset.path, ...extra });
  if (episodes.isLoading) {
    rows.push(<SidebarRow key="loading" id={`${connection.id}-loading`} icon="LoaderCircle" label="Loading episodes…" onPress={() => {}} />);
  } else if (episodes.error) {
    rows.push(
      <SidebarRow
        key="error"
        id={`${connection.id}-error`}
        icon="CircleAlert"
        label="Could not list episodes"
        onPress={() => openScreen({ screenId: SCREEN, params: params({}) })}
      />,
    );
  }
  const list = episodes.data?.episodes ?? [];
  for (const episode of list.slice(0, EPISODE_ROWS)) {
    const session = sessions.find((s) => s.root === dataset.path && s.episode === episode.index && s.state !== "stopped" && s.state !== "error");
    rows.push(
      <SidebarRow
        key={episode.index}
        id={`${connection.id}-${dataset.path}-e${episode.index}`}
        icon={sessionIcon(session)}
        label={episodeLabel(episode, dataset.fps)}
        active={current?.c === connection.id && current?.d === dataset.path && current?.e === String(episode.index)}
        // The screen opens the viewer: only screens can open a browser tab.
        onPress={() => openScreen({ screenId: SCREEN, params: params({ e: String(episode.index), t: String(Date.now()) }) })}
      />,
    );
  }
  if (list.length > EPISODE_ROWS) {
    rows.push(
      <SidebarRow
        key="all"
        id={`${connection.id}-${dataset.path}-all`}
        icon="List"
        label={`All ${list.length} episodes…`}
        onPress={() => openScreen({ screenId: SCREEN, params: params({}) })}
      />,
    );
  }
  return <>{rows}</>;
}

/** A dataset connection: its episodes, with durations from the dataset's fps. */
function DatasetConnectionRows(props: {
  connection: Connection;
  sessions: readonly Session[];
  current: Record<string, string> | null;
  openScreen: PluginSidebarItemProps["openScreen"];
}) {
  const { connection } = props;
  const listDatasets = useRpc(listDatasetsRpc);
  // Same query as the dataset screen, so it is usually cached already.
  const datasets = useQuery({
    queryKey: [KEY, "datasets", connection.serverId, connection.path],
    queryFn: () => listDatasets({ serverId: connection.serverId || undefined, roots: [connection.path], only: true, refresh: false }),
    staleTime: 60_000,
  });
  const fps = datasets.data?.datasets.find((d) => d.path === connection.path)?.fps ?? 0;
  return <EpisodeRows {...props} dataset={{ path: connection.path, fps }} />;
}

/** Datasets inside a folder connection; an expanded one shows its episodes. */
function CollectionRows(props: {
  connection: Connection;
  expanded: readonly string[];
  toggle: (key: string, open?: boolean) => void;
  sessions: readonly Session[];
  current: Record<string, string> | null;
  openScreen: PluginSidebarItemProps["openScreen"];
  muted: string;
}) {
  const { connection, expanded, toggle, sessions, current, openScreen, muted } = props;
  const listDatasets = useRpc(listDatasetsRpc);
  const datasets = useQuery({
    queryKey: [KEY, "datasets", connection.serverId, connection.path],
    queryFn: () => listDatasets({ serverId: connection.serverId || undefined, roots: [connection.path], only: true, refresh: false }),
    staleTime: 60_000,
  });
  const list: Dataset[] = datasets.data?.datasets ?? [];
  // The dataset open on the screen comes first, so it is always reachable.
  const ordered = [...list].sort((a, b) => Number(b.path === current?.d) - Number(a.path === current?.d));
  const rows: ReactNode[] = [];
  if (datasets.isLoading) {
    rows.push(<SidebarRow key="loading" id={`${connection.id}-loading`} icon="LoaderCircle" label="Looking for datasets…" onPress={() => {}} />);
  }
  for (const dataset of ordered.slice(0, DATASET_ROWS)) {
    const key = `${connection.id}\n${dataset.path}`;
    const open = expanded.includes(key);
    rows.push(
      <SidebarRow
        key={dataset.path}
        id={`${connection.id}-${dataset.path}`}
        icon="Database"
        label={dataset.name}
        active={current?.c === connection.id && current?.d === dataset.path && !current?.e}
        onPress={() => {
          toggle(key, true);
          openScreen({ screenId: SCREEN, params: { c: connection.id, d: dataset.path } });
        }}
        trailing={<Chevron open={open} onPress={() => toggle(key)} color={muted} label={`${open ? "Hide" : "Show"} episodes of ${dataset.name}`} />}
      />,
    );
    if (open) {
      rows.push(
        <EpisodeRows key={`${dataset.path}-episodes`} connection={connection} dataset={dataset} sessions={sessions} current={current} openScreen={openScreen} />,
      );
    }
  }
  if (list.length > DATASET_ROWS) {
    rows.push(
      <SidebarRow
        key="all"
        id={`${connection.id}-all`}
        icon="List"
        label={`All ${list.length} datasets…`}
        onPress={() => openScreen({ screenId: SCREEN, params: { c: connection.id } })}
      />,
    );
  }
  return <>{rows}</>;
}

/** A small text button for the right slot of a sidebar row. */
function SlotButton({ text, onPress, color, label }: { text: string; onPress: () => void; color: string; label: string }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={8} style={{ paddingHorizontal: 6 }}>
      <Text style={{ color, fontSize: 12 }}>{text}</Text>
    </Pressable>
  );
}

export function SidebarTree({ currentScreen, openScreen, theme }: PluginSidebarItemProps) {
  const { connections, save: saveConnections } = useConnections();
  /** The connection whose row asks "Disconnect …?". */
  const [confirming, setConfirming] = useState<string | null>(null);
  const state = useSettings(sidebarSettings);
  const readSessions = useRpc(sessionsRpc);
  const values = state.status === "ready" ? state.values : { open: false, expanded: [] as string[] };
  const save = (next: typeof values) => {
    if (state.status === "ready") void state.save(next, state.revision);
  };
  const toggle = (key: string, open?: boolean) => {
    const isOpen = values.expanded.includes(key);
    const want = open ?? !isOpen;
    if (want === isOpen) return;
    save({ ...values, expanded: want ? [...values.expanded, key] : values.expanded.filter((k) => k !== key) });
  };
  const sessions =
    useQuery({
      queryKey: [KEY, "sessions"],
      queryFn: () => readSessions({}),
      enabled: values.open,
      refetchInterval: 3000,
    }).data?.sessions ?? [];
  const current = currentScreen?.screenId === SCREEN ? currentScreen.params : null;
  const muted = theme.colors.foregroundMuted;

  const rows: ReactNode[] = [
    <SidebarRow
      key="root"
      icon="Clapperboard"
      active={current !== null && !current.c}
      onPress={() => save({ ...values, open: !values.open })}
      trailing={
        <Chevron
          open={values.open}
          onPress={() => save({ ...values, open: !values.open })}
          color={muted}
          label={values.open ? "Hide LeRobot datasets" : "Show LeRobot datasets"}
        />
      }
    />,
  ];
  if (!values.open) return <>{rows}</>;

  const disconnect = async (connection: Connection) => {
    setConfirming(null);
    await saveConnections(connections.filter((entry) => entry.id !== connection.id));
    save({ ...values, expanded: values.expanded.filter((key) => key !== connection.id && !key.startsWith(`${connection.id}\n`)) });
    if (current?.c === connection.id) openScreen({ screenId: SCREEN, params: { c: "" } });
  };

  for (const connection of connections) {
    const open = values.expanded.includes(connection.id);
    if (confirming === connection.id) {
      // Disconnecting only removes the folder from this list; nothing is deleted on the host.
      rows.push(
        <SidebarRow
          key={connection.id}
          id={connection.id}
          icon="CircleAlert"
          label={`Disconnect ${connection.name}?`}
          onPress={() => setConfirming(null)}
          trailing={
            <View style={{ flexDirection: "row" }}>
              <SlotButton text="Yes" color={theme.colors.statusDanger} label={`Disconnect ${connection.name}`} onPress={() => void disconnect(connection)} />
              <SlotButton text="No" color={muted} label="Keep this folder" onPress={() => setConfirming(null)} />
            </View>
          }
        />,
      );
      continue;
    }
    rows.push(
      <SidebarRow
        key={connection.id}
        id={connection.id}
        icon={connection.kind === "dataset" ? "Database" : "FolderOpen"}
        label={connectionLabel(connection)}
        active={current?.c === connection.id && !current?.d}
        onPress={() => {
          toggle(connection.id, true);
          openScreen({ screenId: SCREEN, params: { c: connection.id } });
        }}
        trailing={
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <SlotButton text="✕" color={muted} label={`Disconnect ${connection.name}`} onPress={() => setConfirming(connection.id)} />
            <Chevron open={open} onPress={() => toggle(connection.id)} color={muted} label={`${open ? "Collapse" : "Expand"} ${connection.name}`} />
          </View>
        }
      />,
    );
    if (!open) continue;
    rows.push(
      connection.kind === "dataset" ? (
        <DatasetConnectionRows key={`${connection.id}-episodes`} connection={connection} sessions={sessions} current={current} openScreen={openScreen} />
      ) : (
        <CollectionRows
          key={`${connection.id}-datasets`}
          connection={connection}
          expanded={values.expanded}
          toggle={toggle}
          sessions={sessions}
          current={current}
          openScreen={openScreen}
          muted={muted}
        />
      ),
    );
  }
  rows.push(
    <SidebarRow
      key="connect"
      id="connect"
      icon="FolderOpen"
      label="Connect folder…"
      onPress={() => openScreen({ screenId: SCREEN, params: { c: "", connect: "1", t: String(Date.now()) } })}
    />,
  );
  return <>{rows}</>;
}
