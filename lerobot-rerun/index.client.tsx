import type {
  PluginClientContext,
  PluginScreenProps,
} from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { DatasetBrowser, type ScreenRequest } from "./client/browser";
import { SCREEN, SidebarTree } from "./client/sidebar";
import { ParquetPanel } from "./client/parquet";
import { hostRoleRpc } from "./shared/rpc";
import { SettingsScreen } from "./client/settings";

const TITLE = "LeRobot datasets";
const ICON = "Clapperboard";

function Screen(props: PluginScreenProps) {
  const { c = "", d, e, t, connect } = props.params;
  // In-screen navigation is local; a sidebar click changes the params and takes over again.
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => setLocal(null), [c, t, d]);
  const connectionId = local ?? c;
  const request: ScreenRequest | undefined =
    local === null ? { dataset: d, episode: e === undefined ? undefined : Number(e), connect: connect === "1", nonce: t } : undefined;
  return (
    <DatasetBrowser {...props} connectionId={connectionId || undefined} request={request} onNavigate={(id) => setLocal(id ?? "")} />
  );
}

export default function contribute(client: PluginClientContext) {
  const removers: (() => void)[] = [];
  let stopped = false;
  // .parquet files in any workspace's file explorer open as a table, on every host.
  removers.push(
    client.addFilePanel({ id: "parquet", title: "Parquet table", icon: "Table", files: { extensions: ["parquet"] }, Component: ParquetPanel }),
  );
  removers.push(client.addSettingsScreen({ id: "settings", title: "LeRobot Rerun viewer", icon: ICON, Component: SettingsScreen }));

  // The dataset screen and sidebar only on hosts that are not dataset hosts for another computer.
  const addInterface = () => {
    if (stopped) return;
    removers.push(client.addScreen({ id: SCREEN, title: TITLE, Component: Screen }));
    removers.push(client.addSidebarHeaderItem({ id: SCREEN, title: TITLE, Component: SidebarTree }));
    removers.push(
      client.addCommandCenterItem({
        id: "open-datasets",
        title: "Open LeRobot datasets",
        icon: ICON,
        keywords: ["lerobot", "rerun", "dataset", "episode", "viewer"],
        context: "global",
        onSelect: ({ openScreen }) => openScreen({ screenId: SCREEN, params: { c: "" } }),
      }),
    );
  };
  client.rpc(hostRoleRpc, {}).then(
    ({ ui }) => {
      if (ui) addInterface();
    },
    // A host running an older version cannot answer: show the screen as before.
    () => addInterface(),
  );

  return () => {
    stopped = true;
    for (const remove of removers) remove();
  };
}
