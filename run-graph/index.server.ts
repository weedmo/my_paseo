import type { PluginServerContext } from "@getpaseo/plugin/server";
import { RunService } from "./server/service.ts";
import { listRunsRpc, liveCountRpc, runDetailRpc } from "./shared/rpc.ts";

// Read-only: the handlers only read files under ~/.claude/projects and the
// repo's checkouts. Nothing is written, started, stopped or messaged.
export default function contribute(server: PluginServerContext) {
  const service = new RunService();
  server.handle(listRunsRpc, ({ workspacePath, days }) => service.list(workspacePath, days ?? 30));
  server.handle(runDetailRpc, ({ workspacePath, runId }) => ({ run: service.detail(workspacePath, runId) }));
  server.handle(liveCountRpc, ({ workspacePath }) => ({ live: service.liveCount(workspacePath) }));
  return () => {};
}
