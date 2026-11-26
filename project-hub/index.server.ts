import type { PluginServerContext } from "@getpaseo/plugin/server";
import { resolveRepos } from "./server/github";
import { Hosts } from "./server/hosts";
import { projectHandlers } from "./server/projects";
import { resolveGithubRepos } from "./shared/github";
import { removeProjects, renameProjects } from "./shared/projects";

export default function contribute(server: PluginServerContext) {
  const hosts = new Hosts();
  const projects = projectHandlers(hosts);
  server.handle(resolveGithubRepos, resolveRepos);
  server.handle(renameProjects, projects.rename);
  server.handle(removeProjects, projects.remove);
  return () => hosts.close();
}
