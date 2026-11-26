import type { PluginClientContext } from "@getpaseo/plugin/client";
import { LiveRunsBadge } from "./client/badge.tsx";
import { RunGraphPanel } from "./client/panel.tsx";

export default function contribute(client: PluginClientContext) {
  const removers = [
    // The right sidebar (Explorer) is the home of the panel; a workspace tab is also allowed.
    client.addWorkspacePanel({ id: "run-graph", title: "Run Graph", icon: "GitFork", locations: ["explorer", "workspace"], Component: RunGraphPanel }),
    client.addCommandCenterItem({
      id: "open-run-graph",
      title: "Open Run Graph",
      icon: "GitFork",
      keywords: ["matt", "workflow", "autocode", "runs", "graph", "sidebar", "explorer"],
      context: "workspace",
      onSelect({ openPanel }) {
        openPanel("run-graph", { location: "explorer" });
      },
    }),
    client.addCommandCenterItem({
      id: "open-run-graph-tab",
      title: "Open Run Graph in a tab",
      icon: "GitFork",
      keywords: ["matt", "workflow", "autocode", "runs", "graph"],
      context: "workspace",
      onSelect({ openPanel }) {
        openPanel("run-graph", { location: "workspace" });
      },
    }),
  ];
  // Apps older than this API have no workspace row badges.
  if (typeof client.addWorkspaceRowBadgeItem === "function") {
    removers.push(client.addWorkspaceRowBadgeItem({ id: "live-runs", title: "Live runs", icon: "GitFork", Component: LiveRunsBadge }));
  }
  return () => removers.forEach((remove) => remove());
}
