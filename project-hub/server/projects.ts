import type { RpcInput } from "@getpaseo/plugin";
import type { removeProjects, renameProjects } from "../shared/projects";
import { errorMessage, type Hosts } from "./hosts";

export function projectHandlers(hosts: Hosts) {
  return {
    async rename({ targets, customName }: RpcInput<typeof renameProjects>) {
      const name = customName?.trim() || null;
      const results = await Promise.all(
        targets.map(async ({ serverId, projectId }) => {
          try {
            await (await hosts.client(serverId)).renameProject(projectId, name);
            return { serverId, projectId, ok: true };
          } catch (error) {
            return { serverId, projectId, ok: false, error: errorMessage(error) };
          }
        }),
      );
      return { results };
    },
    async remove({ targets }: RpcInput<typeof removeProjects>) {
      const results = await Promise.all(
        targets.map(async ({ serverId, projectId }) => {
          try {
            const { removedWorkspaceIds } = await (await hosts.client(serverId)).removeProject(projectId);
            return { serverId, projectId, ok: true, removedWorkspaces: removedWorkspaceIds.length };
          } catch (error) {
            return { serverId, projectId, ok: false, error: errorMessage(error) };
          }
        }),
      );
      return { results };
    },
  };
}
