// Pure grouping logic: merge per-host Paseo projects into logical repositories.

export interface HostProject {
  readonly hostId: string;
  readonly projectId: string;
  readonly projectKey: string | null;
  readonly displayName: string;
  readonly rootPath: string;
  /** Name the user set in Paseo for this host project, if any. */
  readonly customName?: string | null;
}

export interface HostWorkspace {
  readonly hostId: string;
  readonly projectId: string;
  readonly workspaceId: string;
}

export interface CheckoutEntry {
  readonly project: HostProject;
  readonly workspaceIds: readonly string[];
}

export interface HostEntry {
  readonly hostId: string;
  readonly checkouts: readonly CheckoutEntry[];
}

export interface RepoGroup {
  readonly key: string;
  /** Custom project name if one is set, else the repository name without the owner, else the directory name. */
  readonly title: string;
  /** Repository name without the owner; null for host-local projects. */
  readonly repoName: string | null;
  /** Repository owner (user or organization), lowercase; null for host-local projects. */
  readonly owner: string | null;
  /** Remote host such as "github.com"; null for host-local projects. */
  readonly forge: string | null;
  /** True when the key is a git remote, false for a host-local directory. */
  readonly isRemote: boolean;
  readonly hosts: readonly HostEntry[];
  readonly workspaceCount: number;
}

const REMOTE_PREFIX = "remote:";

/** Normalize a Paseo projectKey into a cross-host repository key, or null when it is host-local. */
export function repoKeyOf(projectKey: string | null | undefined): string | null {
  if (!projectKey || !projectKey.startsWith(REMOTE_PREFIX)) return null;
  const remote = projectKey
    .slice(REMOTE_PREFIX.length)
    .trim()
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  return remote ? `${REMOTE_PREFIX}${remote}` : null;
}

function describe(repoKey: string | null, project: HostProject) {
  if (!repoKey) return { title: project.displayName, repoName: null, owner: null, forge: null };
  const parts = repoKey.slice(REMOTE_PREFIX.length).split("/");
  // github.com/owner/repo -> repo, owned by owner
  if (parts.length >= 3) {
    const repoName = parts.slice(2).join("/");
    return { title: repoName, repoName, owner: parts[1]!, forge: parts[0]! };
  }
  return { title: parts.join("/"), repoName: parts.join("/"), owner: null, forge: parts[0] ?? null };
}

/** The bare remote ("github.com/owner/repo") of a project, or null when it has none. */
export function remoteOf(projectKey: string | null | undefined): string | null {
  const key = repoKeyOf(projectKey);
  return key ? key.slice(REMOTE_PREFIX.length) : null;
}

export function projectRefKey(hostId: string, projectId: string): string {
  return `${hostId}\u0000${projectId}`;
}

export function groupRepositories(
  projects: readonly HostProject[],
  workspaces: readonly HostWorkspace[],
  hostOrder: readonly string[],
  /** Bare remote -> canonical bare remote, e.g. from GitHub rename lookups. */
  canonical: Readonly<Record<string, string>> = {},
): RepoGroup[] {
  const workspacesByProject = new Map<string, string[]>();
  for (const workspace of workspaces) {
    const key = projectRefKey(workspace.hostId, workspace.projectId);
    const list = workspacesByProject.get(key) ?? [];
    list.push(workspace.workspaceId);
    workspacesByProject.set(key, list);
  }

  interface Draft {
    key: string;
    title: string;
    repoName: string | null;
    owner: string | null;
    forge: string | null;
    isRemote: boolean;
    hosts: Map<string, CheckoutEntry[]>;
  }
  const drafts = new Map<string, Draft>();
  for (const project of projects) {
    const rawKey = repoKeyOf(project.projectKey);
    const rawRemote = rawKey ? rawKey.slice(REMOTE_PREFIX.length) : null;
    const repoKey = rawRemote ? `${REMOTE_PREFIX}${canonical[rawRemote] ?? rawRemote}` : null;
    const key = repoKey ?? `local:${project.hostId}:${project.rootPath}`;
    let draft = drafts.get(key);
    if (!draft) {
      draft = { key, ...describe(repoKey, project), isRemote: repoKey !== null, hosts: new Map() };
      drafts.set(key, draft);
    }
    if (project.customName?.trim()) draft.title = project.customName.trim();
    const checkouts = draft.hosts.get(project.hostId) ?? [];
    checkouts.push({
      project,
      workspaceIds: workspacesByProject.get(projectRefKey(project.hostId, project.projectId)) ?? [],
    });
    draft.hosts.set(project.hostId, checkouts);
  }

  const hostRank = (hostId: string) => {
    const index = hostOrder.indexOf(hostId);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };

  const groups: RepoGroup[] = [...drafts.values()].map((draft) => {
    const hosts = [...draft.hosts.entries()]
      .sort(([a], [b]) => hostRank(a) - hostRank(b) || a.localeCompare(b))
      .map(([hostId, checkouts]) => ({
        hostId,
        checkouts: [...checkouts].sort((a, b) => a.project.rootPath.localeCompare(b.project.rootPath)),
      }));
    const workspaceCount = hosts.reduce(
      (sum, host) => sum + host.checkouts.reduce((inner, checkout) => inner + checkout.workspaceIds.length, 0),
      0,
    );
    const { key, title, repoName, owner, forge, isRemote } = draft;
    return { key, title, repoName, owner, forge, isRemote, hosts, workspaceCount };
  });

  // Repositories spanning several hosts first, then busier ones, then by name.
  return groups.sort(
    (a, b) =>
      b.hosts.length - a.hosts.length ||
      b.workspaceCount - a.workspaceCount ||
      a.title.localeCompare(b.title),
  );
}
