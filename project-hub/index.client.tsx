import type { PluginClientContext } from "@getpaseo/plugin/client";
import { RepoSidebar } from "./client/hub";

export default function contribute(client: PluginClientContext) {
  client.addSidebarView({
    id: "repositories",
    title: "Repositories across hosts",
    description: "One entry per git repository, with each host's checkouts and workspaces under it.",
    Component: RepoSidebar,
  });
  return () => {};
}
