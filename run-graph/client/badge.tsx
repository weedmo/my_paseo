import { type PluginWorkspaceRowBadgeItemProps, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { WorkspaceRowBadge } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { liveCountRpc } from "../shared/rpc.ts";

/** "n live" under a workspace in the sidebar while runs of its repository are live. */
export function LiveRunsBadge({ workspaceId }: PluginWorkspaceRowBadgeItemProps) {
  const dir = useWorkspace(workspaceId, (w) => w.directory);
  const liveCount = useRpc(liveCountRpc);
  const { data } = useQuery({
    queryKey: ["run-graph", "live", dir],
    queryFn: () => liveCount({ workspacePath: dir! }),
    enabled: Boolean(dir),
    // The sidebar is always open: poll slowly; the panel polls at 3 s while it is open.
    refetchInterval: 30_000,
  });
  if (!data?.live) return null;
  return <WorkspaceRowBadge icon="GitFork" label={`${data.live} live`} tone="info" accessibilityLabel={`${data.live} live runs`} />;
}
