import {
  getPaseoClient,
  useHosts,
  useProjects,
  useRpc,
  useSettings,
  useWorkspace,
  useWorkspaces,
  type PluginHostSummary,
  type PluginSidebarViewProps,
  type ProjectRef,
  type WorkspaceRef,
} from "@getpaseo/plugin/client";
import type { PluginWorkspaceSnapshot } from "@getpaseo/plugin";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import { resolveGithubRepos } from "../shared/github";
import { ProjectSettingsModal } from "./project-settings";
import { StatusGlyph } from "./status-glyph";
import { useSidebarShortcuts } from "./web";
import { sidebarPreferences } from "../shared/preferences";
import {
  groupRepositories,
  projectRefKey,
  remoteOf,
  type CheckoutEntry,
  type HostEntry,
  type HostProject,
  type HostWorkspace,
  type RepoGroup,
} from "./grouping";

type Theme = PluginSidebarViewProps["theme"];
type Navigation = PluginSidebarViewProps["navigation"];

const SEP = "\u0000";

// Geometry copied from Paseo's built-in sidebar (sidebar-workspace-list.tsx, pointer density).
const ROW_HEIGHT = 36;
const STATUS_SLOT = 14;
const INDENT = 16;

// Module-level so the projections keep stable queries.
const visibleWorkspace = (ws: PluginWorkspaceSnapshot) => !ws.background && !ws.archivingAt;
const byHostProject = (ws: PluginWorkspaceSnapshot) => ({
  key: `${ws.hostId}${SEP}${ws.projectId}`,
  title: `${ws.projectDisplayName}${SEP}${ws.projectRootPath}`,
});
const WORKSPACE_QUERY = { where: visibleWorkspace, groupBy: byHostProject, orderBy: "name" as const };

interface ProjectsResult {
  readonly projects: HostProject[];
  readonly failedHosts: string[];
}

/** Paseo's plugin snapshots omit the git remote, so read projectKey from each host's project list. */
async function loadProjects(hostIds: readonly string[]): Promise<ProjectsResult> {
  const results = await Promise.allSettled(
    hostIds.map(async (hostId) => {
      const { projects } = await getPaseoClient(hostId).projects.list();
      return projects.map<HostProject>((project) => ({
        hostId,
        projectId: project.projectId,
        projectKey: project.projectKey ?? null,
        displayName: project.projectCustomName || project.projectDisplayName,
        rootPath: project.projectRootPath,
        customName: project.projectCustomName ?? null,
      }));
    }),
  );
  const projects: HostProject[] = [];
  const failedHosts: string[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") projects.push(...result.value);
    else failedHosts.push(hostIds[index]!);
  });
  return { projects, failedHosts };
}

export function RepoSidebar({ theme, layout, active, navigation }: PluginSidebarViewProps) {
  const hosts = useHosts();
  const onlineHostIds = useMemo(
    () => hosts.filter((host) => host.status === "online").map((host) => host.serverId),
    [hosts],
  );
  const projectsQuery = useQuery({
    queryKey: ["project-hub", "projects", onlineHostIds.join(",")],
    queryFn: () => loadProjects(onlineHostIds),
    enabled: onlineHostIds.length > 0,
    refetchInterval: 30_000,
  });

  // Follow GitHub renames so old and new remotes of one repository land in one group.
  const resolve = useRpc(resolveGithubRepos);
  const githubRemotes = useMemo(() => {
    const remotes = new Set<string>();
    for (const project of projectsQuery.data?.projects ?? []) {
      const remote = remoteOf(project.projectKey);
      if (remote?.startsWith("github.com/")) remotes.add(remote);
    }
    return [...remotes].sort();
  }, [projectsQuery.data]);
  const canonicalQuery = useQuery({
    queryKey: ["project-hub", "github", githubRemotes.join(",")],
    queryFn: () => resolve({ remotes: githubRemotes }),
    enabled: githubRemotes.length > 0,
    staleTime: 60 * 60 * 1000,
    retry: 1,
  });

  const workspaceGroups = useWorkspaces(WORKSPACE_QUERY);
  const projectRefs = useProjects();
  const settings = useSettings(sidebarPreferences);
  const collapsed = settings.status === "ready" ? settings.values.collapsed : [];
  const toggle = useCallback(
    (key: string) => {
      if (settings.status !== "ready") return;
      const current = settings.values.collapsed;
      void settings.save(
        { collapsed: current.includes(key) ? current.filter((item) => item !== key) : [...current, key] },
        settings.revision,
      );
    },
    [settings],
  );

  const model = useMemo(() => {
    const workspaces: HostWorkspace[] = [];
    const workspaceRefs = new Map<string, WorkspaceRef>();
    const knownProjects = new Map<string, HostProject>();
    for (const project of projectsQuery.data?.projects ?? []) {
      knownProjects.set(projectRefKey(project.hostId, project.projectId), project);
    }
    for (const group of workspaceGroups) {
      const [hostId = "", projectId = ""] = group.key.split(SEP);
      // A workspace whose host did not answer the project list still shows, ungrouped.
      if (!knownProjects.has(group.key)) {
        const [displayName = projectId, rootPath = ""] = (group.title ?? "").split(SEP);
        knownProjects.set(group.key, { hostId, projectId, projectKey: null, displayName, rootPath });
      }
      for (const ref of group.items) {
        workspaces.push({ hostId, projectId, workspaceId: ref.id });
        workspaceRefs.set(`${hostId}${SEP}${ref.id}`, ref);
      }
    }
    const projectRefMap = new Map<string, ProjectRef>();
    for (const ref of projectRefs) projectRefMap.set(projectRefKey(ref.hostId, ref.id), ref);
    return {
      groups: groupRepositories(
        [...knownProjects.values()],
        workspaces,
        hosts.map((host) => host.serverId),
        canonicalQuery.data?.canonical ?? {},
      ),
      workspaceRefs,
      projectRefMap,
    };
  }, [projectsQuery.data, canonicalQuery.data, workspaceGroups, projectRefs, hosts]);

  const hostsById = useMemo(() => new Map(hosts.map((host) => [host.serverId, host])), [hosts]);
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
  const failedHosts = projectsQuery.data?.failedHosts ?? [];

  // Workspaces in display order, skipping collapsed repositories, for Mod+1..9 and Mod+[ / ].
  const ordered = useMemo(() => {
    const refs: WorkspaceRef[] = [];
    for (const group of model.groups) {
      if (collapsed.includes(group.key)) continue;
      for (const host of group.hosts)
        for (const checkout of host.checkouts)
          for (const id of checkout.workspaceIds) {
            const ref = model.workspaceRefs.get(`${host.hostId}${SEP}${id}`);
            if (ref) refs.push(ref);
          }
    }
    return refs;
  }, [model, collapsed]);
  const shortcutIndex = useMemo(
    () => new Map(ordered.slice(0, 9).map((ref, index) => [ref.key, index + 1])),
    [ordered],
  );
  const activeKey = active.workspace?.key ?? null;
  const modifierHeld = useSidebarShortcuts({
    jump: (index) => {
      const ref = ordered[index - 1];
      if (ref) navigation.openWorkspace(ref);
    },
    step: (delta) => {
      if (ordered.length === 0) return;
      const current = ordered.findIndex((ref) => ref.key === activeKey);
      const next = current === -1 ? (delta > 0 ? 0 : ordered.length - 1) : (current + delta + ordered.length) % ordered.length;
      navigation.openWorkspace(ordered[next]!);
    },
  });

  const shared: Shared = {
    hostsById,
    workspaceRefs: model.workspaceRefs,
    projectRefMap: model.projectRefMap,
    activeWorkspaceKey: active.workspace?.key ?? null,
    navigation,
    styles,
    theme,
    avatars: canonicalQuery.data?.avatars ?? {},
    onChanged: () => void projectsQuery.refetch(),
    shortcutIndex,
    showShortcuts: modifierHeld,
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      {failedHosts.length > 0 ? (
        <Text style={styles.notice}>
          No project list from {failedHosts.map((id) => hostsById.get(id)?.label ?? id).join(", ")}
        </Text>
      ) : null}
      {model.groups.map((group) => (
        <RepoBlock
          key={group.key}
          {...shared}
          group={group}
          open={!collapsed.includes(group.key)}
          onToggle={() => toggle(group.key)}
        />
      ))}
    </ScrollView>
  );
}

interface Shared {
  hostsById: ReadonlyMap<string, PluginHostSummary>;
  workspaceRefs: ReadonlyMap<string, WorkspaceRef>;
  projectRefMap: ReadonlyMap<string, ProjectRef>;
  activeWorkspaceKey: string | null;
  navigation: Navigation;
  styles: Styles;
  theme: Theme;
  /** Owner login -> avatar data URI. */
  avatars: Readonly<Record<string, string>>;
  /** Refresh project lists after a rename or removal. */
  onChanged(): void;
  /** Workspace ref key -> 1..9 for Mod+digit. */
  shortcutIndex: ReadonlyMap<string, number>;
  /** True while the platform modifier is held: show number badges like Paseo. */
  showShortcuts: boolean;
}

/** Owner avatar, or a folder glyph when there is none; a chevron while hovered, like Paseo's project rows. */
function ProjectVisual(props: { group: RepoGroup; hovered: boolean; open: boolean; avatars: Shared["avatars"]; styles: Styles; theme: Theme }) {
  const { group, styles } = props;
  const [failed, setFailed] = useState(false);
  const avatar = group.owner ? props.avatars[group.owner] : undefined;
  if (props.hovered) {
    return <Icon name={props.open ? "ChevronDown" : "ChevronRight"} size={14} color={props.theme.colors.foregroundMuted} />;
  }
  if (avatar && !failed) {
    return (
      <Image
        source={{ uri: avatar }}
        style={styles.avatar}
        accessibilityLabel={group.owner ?? undefined}
        onError={() => setFailed(true)}
      />
    );
  }
  return <Icon name={group.isRemote ? "FolderGit2" : "Folder"} size={14} color={props.theme.colors.foregroundMuted} />;
}

/** A pressable row with Paseo's hover and pressed fills, plus an optional hover-revealed trailing slot. */
function HoverRow(props: {
  style: object;
  selected?: boolean;
  accessibilityLabel: string;
  onPress(): void;
  styles: Styles;
  children: (hovered: boolean) => ReactNode;
  trailing?: (hovered: boolean) => ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const { styles } = props;
  return (
    <View
      style={styles.rowFrame}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel}
        onPress={props.onPress}
        style={({ pressed }) => [
          props.style,
          props.selected && styles.selected,
          hovered && !props.selected && styles.hovered,
          pressed && styles.pressed,
        ]}
      >
        {props.children(hovered)}
      </Pressable>
      {props.trailing ? <View style={styles.trailing}>{props.trailing(hovered)}</View> : null}
    </View>
  );
}

function IconButton(props: { icon: string; label: string; visible: boolean; onPress(): void; styles: Styles; theme: Theme }) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[props.styles.iconButton, hovered && props.styles.iconButtonHovered, !props.visible && props.styles.hidden]}
    >
      <Icon name={props.icon} size={14} color={props.theme.colors.foregroundMuted} />
    </Pressable>
  );
}

function RepoBlock(props: Shared & { group: RepoGroup; open: boolean; onToggle(): void }) {
  const { group, styles, theme } = props;
  const multiHost = group.hosts.length > 1;
  const single = !multiHost && group.hosts[0]?.checkouts.length === 1 ? group.hosts[0] : null;
  const singleProjectRef = single
    ? props.projectRefMap.get(projectRefKey(single.hostId, single.checkouts[0]!.project.projectId))
    : undefined;
  const singleHost = single ? props.hostsById.get(single.hostId) : undefined;
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <View style={props.open ? styles.blockExpanded : undefined}>
      {settingsOpen ? (
        <ProjectSettingsModal
          group={group}
          hostsById={props.hostsById}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          onChanged={props.onChanged}
          theme={theme}
        />
      ) : null}
      <HoverRow
        style={styles.projectRow}
        accessibilityLabel={`${props.open ? "Collapse" : "Expand"} ${group.owner ? `${group.owner}/` : ""}${group.title}`}
        onPress={props.onToggle}
        styles={styles}
        trailing={(hovered) => (
          <View style={styles.trailingGroup}>
            <IconButton
              icon="Settings2"
              label={`Project settings for ${group.title}`}
              visible={hovered}
              onPress={() => setSettingsOpen(true)}
              styles={styles}
              theme={theme}
            />
            {singleProjectRef && singleHost?.status === "online" ? (
              <IconButton
                icon="Plus"
                label={`New workspace in ${group.title}`}
                visible={hovered}
                onPress={() => props.navigation.openProject(singleProjectRef)}
                styles={styles}
                theme={theme}
              />
            ) : null}
          </View>
        )}
      >
        {(hovered) => (
          <>
            <View style={styles.leading}>
              <ProjectVisual group={group} hovered={hovered} open={props.open} avatars={props.avatars} styles={styles} theme={theme} />
            </View>
            <Text style={[styles.projectTitle, hovered && styles.projectTitleHovered]} numberOfLines={1}>
              {group.title}
            </Text>
            {!multiHost && single ? (
              <Text style={styles.meta} numberOfLines={1}>
                {singleHost?.label ?? single.hostId}
              </Text>
            ) : multiHost ? (
              <Text style={styles.meta}>{group.hosts.length} hosts</Text>
            ) : null}
          </>
        )}
      </HoverRow>
      {props.open
        ? group.hosts.map((host) =>
            single ? (
              <Workspaces key={host.hostId} {...props} checkout={host.checkouts[0]!} hostId={host.hostId} indent={INDENT} />
            ) : (
              <HostBlock key={host.hostId} {...props} host={host} />
            ),
          )
        : null}
    </View>
  );
}

function HostBlock(props: Shared & { host: HostEntry }) {
  const { host, styles, theme } = props;
  const summary = props.hostsById.get(host.hostId);
  const online = summary?.status === "online";
  return (
    <View>
      {host.checkouts.map((checkout) => {
        const projectRef = props.projectRefMap.get(projectRefKey(host.hostId, checkout.project.projectId));
        const folder = checkout.project.rootPath.split("/").filter(Boolean).pop() ?? checkout.project.displayName;
        return (
          <View key={checkout.project.projectId}>
            <HoverRow
              style={styles.hostRow}
              accessibilityLabel={`New workspace on ${summary?.label ?? host.hostId} in ${checkout.project.rootPath}`}
              onPress={() => projectRef && online && props.navigation.openProject(projectRef)}
              styles={styles}
              trailing={(hovered) =>
                projectRef && online ? (
                  <IconButton
                    icon="Plus"
                    label={`New workspace on ${summary?.label ?? host.hostId}`}
                    visible={hovered}
                    onPress={() => props.navigation.openProject(projectRef)}
                    styles={styles}
                    theme={theme}
                  />
                ) : null
              }
            >
              {() => (
                <>
                  <View style={styles.leading}>
                    <Icon name="Server" size={12} color={online ? theme.colors.foregroundMuted : theme.colors.border} />
                  </View>
                  <Text style={[styles.hostLabel, !online && styles.offline]} numberOfLines={1}>
                    {summary?.label ?? host.hostId}
                    {host.checkouts.length > 1 ? <Text style={styles.meta}>{`  ${folder}`}</Text> : null}
                  </Text>
                  {!online && summary ? <Text style={styles.meta}>{summary.status}</Text> : null}
                </>
              )}
            </HoverRow>
            <Workspaces {...props} checkout={checkout} hostId={host.hostId} indent={INDENT * 2} />
          </View>
        );
      })}
    </View>
  );
}

function Workspaces(props: Shared & { checkout: CheckoutEntry; hostId: string; indent: number }) {
  return (
    <>
      {props.checkout.workspaceIds.map((workspaceId) => {
        const ref = props.workspaceRefs.get(`${props.hostId}${SEP}${workspaceId}`);
        return ref ? <WorkspaceRow key={workspaceId} {...props} workspaceRef={ref} /> : null;
      })}
    </>
  );
}

const selectRow = (ws: PluginWorkspaceSnapshot) => ({
  title: ws.title || ws.name,
  branch: ws.branch,
  kind: ws.kind,
  indicator: ws.indicator,
  additions: ws.diffStat?.additions ?? 0,
  deletions: ws.diffStat?.deletions ?? 0,
});

function WorkspaceRow(props: Shared & { workspaceRef: WorkspaceRef; indent: number }) {
  const { styles, theme } = props;
  const row = useWorkspace(props.workspaceRef, selectRow);
  const toast = useToast();
  const [archiving, setArchiving] = useState(false);
  if (!row) return null;
  const selected = props.workspaceRef.key === props.activeWorkspaceKey;
  const shortcut = props.shortcutIndex.get(props.workspaceRef.key);
  const archive = () => {
    if (archiving) return;
    setArchiving(true);
    getPaseoClient(props.workspaceRef.hostId)
      .workspaces.archive(props.workspaceRef.id)
      .catch((error: unknown) => {
        setArchiving(false);
        toast.error(`Could not archive ${row.title}: ${error instanceof Error ? error.message : String(error)}`);
      });
  };
  return (
    <HoverRow
      style={[styles.workspaceRow, { paddingLeft: 8 + props.indent }, archiving && styles.archiving]}
      selected={selected}
      accessibilityLabel={`Open workspace ${row.title}`}
      onPress={() => props.navigation.openWorkspace(props.workspaceRef)}
      styles={styles}
      trailing={(hovered) =>
        props.showShortcuts && shortcut ? (
          <View style={styles.shortcutBadge}>
            <Text style={styles.shortcutBadgeText}>{shortcut}</Text>
          </View>
        ) : (
          <IconButton
            icon={archiving ? "Loader" : "Archive"}
            label={`Archive workspace ${row.title}`}
            visible={hovered && !archiving}
            onPress={archive}
            styles={styles}
            theme={theme}
          />
        )
      }
    >
      {(hovered) => (
        <>
          <View style={styles.statusSlot}>
            <StatusGlyph indicator={row.indicator} theme={theme} />
          </View>
          <Text style={[styles.workspaceTitle, (hovered || selected) && styles.workspaceTitleStrong]} numberOfLines={1}>
            {row.title}
          </Text>
          {archiving ? (
            <Text style={styles.meta}>Archiving…</Text>
          ) : row.additions || row.deletions ? (
            <Text style={styles.meta}>
              <Text style={{ color: theme.colors.statusSuccess }}>+{row.additions}</Text>{" "}
              <Text style={{ color: theme.colors.statusDanger }}>-{row.deletions}</Text>
            </Text>
          ) : row.kind === "worktree" && row.branch ? (
            <Icon name="GitBranch" size={12} color={theme.colors.foregroundMuted} />
          ) : null}
        </>
      )}
    </HoverRow>
  );
}

type Styles = ReturnType<typeof makeStyles>;

function makeStyles(theme: Theme, compact: boolean) {
  const c = theme.colors;
  const rowHeight = compact ? 44 : ROW_HEIGHT;
  const row = {
    minHeight: rowHeight,
    paddingVertical: 8,
    borderRadius: 8,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
  };
  return {
    root: { flex: 1 },
    content: { paddingHorizontal: 8, paddingTop: 2, paddingBottom: 16 },
    blockExpanded: { paddingBottom: 12 },
    rowFrame: { position: "relative" as const },
    projectRow: { ...row, paddingHorizontal: 8, paddingRight: 64, marginBottom: 4 },
    trailingGroup: { flexDirection: "row" as const, alignItems: "center" as const, gap: 2 },
    hostRow: { ...row, minHeight: compact ? 36 : 28, paddingVertical: 4, paddingLeft: 8 + INDENT, paddingRight: 36, marginBottom: 2 },
    workspaceRow: { ...row, paddingRight: 36, marginBottom: 2 },
    archiving: { opacity: 0.6 },
    // Paseo's sidebar shortcut badge.
    shortcutBadge: {
      minWidth: 18,
      height: 18,
      paddingHorizontal: 4,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      borderRadius: 2,
      borderWidth: 1,
      borderColor: c.surface2,
      backgroundColor: c.surface0,
      marginRight: 3,
    },
    shortcutBadgeText: { color: c.foregroundMuted, fontSize: 12, fontWeight: "500" as const, lineHeight: 14 },
    hovered: { backgroundColor: c.surface1 },
    pressed: { backgroundColor: c.surface2 },
    selected: { backgroundColor: c.surface2 },
    trailing: { position: "absolute" as const, right: 6, top: 0, bottom: 0, justifyContent: "center" as const },
    avatar: { width: 16, height: 16, borderRadius: 4, backgroundColor: c.surface2 },
    leading: { width: 16, height: 16, alignItems: "center" as const, justifyContent: "center" as const },
    projectTitle: { color: c.foregroundMuted, fontSize: 14, fontWeight: "400" as const, flex: 1, minWidth: 0 },
    projectTitleHovered: { color: c.foreground },
    hostLabel: { color: c.foregroundMuted, fontSize: 12, flex: 1, minWidth: 0 },
    offline: { opacity: 0.6 },
    meta: { color: c.foregroundMuted, fontSize: 12, flexShrink: 0 },
    notice: { color: c.statusWarning, fontSize: 12, paddingHorizontal: 8, paddingVertical: 4 },
    statusSlot: { width: STATUS_SLOT, height: 16, alignItems: "center" as const, justifyContent: "center" as const },
    workspaceTitle: { color: c.foreground, fontSize: 14, lineHeight: 20, opacity: 0.76, flex: 1, minWidth: 0 },
    workspaceTitleStrong: { opacity: 1 },
    iconButton: { width: 24, height: 24, borderRadius: 6, alignItems: "center" as const, justifyContent: "center" as const },
    iconButtonHovered: { backgroundColor: c.surface2 },
    // Touch has no hover, so trailing actions stay visible there.
    hidden: compact ? {} : { opacity: 0 },
  };
}
