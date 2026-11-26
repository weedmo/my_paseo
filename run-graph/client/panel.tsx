// The "Run Graph" workspace panel: every run of the workspace's repository as
// lane graphs, nested runs as collapsible sub-graphs, and a detail pane.
// Transcript text is untrusted: it is only ever rendered as plain <Text>.
import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginWorkspacePanelProps, openExternalUrl, useRpc, useTabState, useWorkspace } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import { Pressable, ScrollView, Text, View } from "react-native";
import { z } from "zod";
import { ago, itemDuration } from "../shared/format.ts";
import { buildGraph, type Graph, type GraphNode, indexEdges, liveBelow, topLevel } from "../shared/graph.ts";
import { type Item, type Run, SOURCE_LABEL } from "../shared/model.ts";
import { listRunsRpc, runDetailRpc } from "../shared/rpc.ts";
import { LANE, LaneCell, PAD, ROW, stateColor } from "./lanes.tsx";

const SOURCES = ["matt", "workflow", "autocode"] as const;
const DAYS = [1, 7, 30, 90] as const;

const tabStateSchema = z.object({
  sources: z.array(z.string()),
  liveOnly: z.boolean(),
  days: z.number(),
  expanded: z.array(z.string()),
  open: z.array(z.string()),
  closed: z.array(z.string()),
});
type TabState = z.infer<typeof tabStateSchema>;
const DEFAULT_STATE: TabState = { sources: [...SOURCES], liveOnly: false, days: 30, expanded: [], open: [], closed: [] };

const runState = (status: string) =>
  status === "completed" || status === "done" || status === "confirmed" || status === "recorded" ? "done" : status === "blocked" ? "failed" : status;

function useStyles(theme: PluginTheme, compact: boolean) {
  return useMemo(() => {
    const c = theme.colors;
    return {
      root: { flex: 1, backgroundColor: c.surface0 },
      bar: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 6, paddingHorizontal: compact ? 8 : 12, paddingVertical: 8, borderBottomWidth: 1, borderColor: c.border },
      title: { color: c.foreground, fontSize: 14, fontWeight: "600" as const, marginRight: 6 },
      muted: { color: c.foregroundMuted, fontSize: 12 },
      text: { color: c.foreground, fontSize: 13 },
      small: { color: c.foregroundMuted, fontSize: 11 },
      chip: (on: boolean) => ({ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, borderWidth: 1, borderColor: on ? c.accent : c.border, backgroundColor: on ? c.accent : "transparent" }),
      chipText: (on: boolean) => ({ color: on ? c.accentForeground : c.foregroundMuted, fontSize: 11 }),
      runHeader: (selected: boolean) => ({ flexDirection: "row" as const, alignItems: "center" as const, gap: 8, paddingHorizontal: compact ? 8 : 12, paddingVertical: 6, backgroundColor: selected ? c.surface2 : c.surface1, borderBottomWidth: 1, borderColor: c.border }),
      pill: { paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, backgroundColor: c.surface2 },
      row: (selected: boolean) => ({ flexDirection: "row" as const, alignItems: "center" as const, height: ROW, paddingRight: 10, backgroundColor: selected ? c.surface2 : "transparent" }),
      cell: { color: c.foregroundMuted, fontSize: 11, textAlign: "right" as const, marginLeft: 8, flexShrink: 0 },
      badge: { flexShrink: 0, marginLeft: 6, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8, borderWidth: 1, borderColor: c.accent },
      badgeText: { color: c.accent, fontSize: 10 },
      detail: compact
        ? { maxHeight: 320, borderTopWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }
        : { width: 380, borderLeftWidth: 1, borderColor: c.border, backgroundColor: c.surface1 },
      blockTitle: { color: c.foregroundMuted, fontSize: 11, marginTop: 8 },
      mono: { color: c.foreground, fontSize: 11, fontFamily: "monospace" },
      error: { color: c.statusDanger, fontSize: 12 },
      link: { color: c.accent, fontSize: 12 },
    };
  }, [theme, compact]);
}
type Styles = ReturnType<typeof useStyles>;

export function RunGraphPanel({ theme, layout, workspaceId, tab }: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(workspaceId, (w) => ({ directory: w.directory, name: w.name }));
  const [state, setState] = useTabState(tab, tabStateSchema, DEFAULT_STATE);
  const [selected, setSelected] = useState<{ runId: string; hash: string } | null>(null);
  // The panel lives in the right sidebar (Explorer) or in a workspace tab; it is not told
  // which, so it measures itself. Narrow: detail pane below, rows fit the width.
  const [width, setWidth] = useState(0);
  const narrow = layout.compact || (width > 0 && width < 640);
  const styles = useStyles(theme, narrow);
  const listRuns = useRpc(listRunsRpc);
  const dir = workspace?.directory ?? null;
  const list = useQuery({
    queryKey: ["run-graph", "list", dir, state.days],
    queryFn: () => listRuns({ workspacePath: dir!, days: state.days }),
    enabled: Boolean(dir),
    // The query lives only while the panel is mounted: polling stops when it closes.
    refetchInterval: (q) => (q.state.data?.runs.some((r) => r.live) ? 3000 : 15000),
  });
  const data = list.data;
  const runs = useMemo(() => new Map((data?.runs ?? []).map((r) => [r.runId, r])), [data]);
  const byParent = useMemo(() => indexEdges(data?.edges ?? []), [data]);
  const expanded = useMemo(() => new Set(state.expanded), [state.expanded]);
  // A top-level run with a live run anywhere below it counts as live: it sorts first and opens.
  const { roots, liveTree } = useMemo(() => {
    const liveTree = new Set((data?.runs ?? []).filter((r) => liveBelow(runs, byParent, r.runId, new Set())).map((r) => r.runId));
    const roots = topLevel(data?.runs ?? [], data?.edges ?? [], { sources: new Set(state.sources) })
      .filter((r) => !state.liveOnly || liveTree.has(r.runId))
      .sort((a, b) => Number(liveTree.has(b.runId)) - Number(liveTree.has(a.runId)) || b.mtime - a.mtime);
    return { roots, liveTree };
  }, [data, runs, byParent, state.sources, state.liveOnly]);
  const isOpen = (r: Run, i: number) => (state.open.includes(r.runId) ? true : state.closed.includes(r.runId) ? false : liveTree.has(r.runId) || i === 0);
  const graphs = useMemo(() => {
    const out = new Map<string, Graph>();
    roots.forEach((r, i) => {
      if (isOpen(r, i)) out.set(r.runId, buildGraph(r, runs, byParent, expanded));
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots, runs, byParent, expanded, state.open, state.closed]);

  const update = (patch: Partial<TabState>) => setState({ ...state, ...patch });
  const toggle = (xs: string[], x: string) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);
  const toggleRun = (r: Run, i: number) => {
    const open = isOpen(r, i);
    update({ open: open ? state.open.filter((x) => x !== r.runId) : [...state.open, r.runId], closed: open ? [...state.closed, r.runId] : state.closed.filter((x) => x !== r.runId) });
  };
  const selectedNode = selected ? findNode(graphs, selected.hash) : null;
  const now = data?.readAt ?? 0;

  if (!dir) return <View style={styles.root} />;
  return (
    <View style={styles.root} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
      <View style={styles.bar}>
        <Text style={styles.title}>Run Graph</Text>
        {SOURCES.map((s) => {
          const on = state.sources.includes(s);
          return (
            <Pressable key={s} accessibilityRole="button" accessibilityLabel={`Show ${s} runs`} style={styles.chip(on)} onPress={() => update({ sources: toggle(state.sources, s) })}>
              <Text style={styles.chipText(on)}>{s}</Text>
            </Pressable>
          );
        })}
        <Pressable accessibilityRole="button" accessibilityLabel="Live runs only" style={styles.chip(state.liveOnly)} onPress={() => update({ liveOnly: !state.liveOnly })}>
          <Text style={styles.chipText(state.liveOnly)}>live only</Text>
        </Pressable>
        {DAYS.map((d) => (
          <Pressable key={d} accessibilityRole="button" accessibilityLabel={`Last ${d} days`} style={styles.chip(state.days === d)} onPress={() => update({ days: d })}>
            <Text style={styles.chipText(state.days === d)}>{d}d</Text>
          </Pressable>
        ))}
        <Text style={styles.small}>
          {list.isFetching ? "reading…" : data ? `${data.runs.length} runs · ${data.edges.length} links · ${data.checkouts.length} checkouts` : ""}
        </Text>
      </View>
      {list.error ? <Text style={[styles.error, { padding: 12 }]}>{String((list.error as Error).message ?? list.error)}</Text> : null}
      {data?.errors.map((e) => (
        <Text key={e} style={[styles.error, { paddingHorizontal: 12 }]}>
          {e}
        </Text>
      ))}
      <View style={{ flex: 1, flexDirection: narrow ? "column" : "row" }}>
        <ScrollView style={{ flex: 1 }}>
          {!roots.length && data ? <Text style={[styles.muted, { padding: 16 }]}>No runs for this repository · matt-design, matt-auto, autocode, workflow</Text> : null}
          {roots.map((r, i) => {
            const open = isOpen(r, i);
            const g = graphs.get(r.runId);
            return (
              <View key={r.runId}>
                <Pressable accessibilityRole="button" accessibilityLabel={`${open ? "Collapse" : "Expand"} ${r.name}`} style={styles.runHeader(selected?.runId === r.runId && selected.hash.endsWith("|start"))} onPress={() => toggleRun(r, i)}>
                  <Text style={styles.small}>{open ? "▾" : "▸"}</Text>
                  <View style={styles.pill}>
                    <Text style={styles.small}>{SOURCE_LABEL[r.kind]}</Text>
                  </View>
                  <Text style={[styles.text, { fontWeight: "600", flexShrink: 1 }]} numberOfLines={1}>
                    {r.name}
                  </Text>
                  <Text style={{ color: stateColor(theme, runState(r.status)), fontSize: 11 }}>{r.status}</Text>
                  <Text style={[styles.small, { flex: 1 }]} numberOfLines={1}>
                    {[r.stats, r.children.length ? `${r.children.length} linked` : null, !r.live && liveTree.has(r.runId) ? "live below" : null, ago(r.mtime, now)].filter(Boolean).join(" · ")}
                  </Text>
                </Pressable>
                {g ? (
                  <ScrollView horizontal>
                    <View>
                      {g.nodes.map((n, k) => (
                        <NodeRow
                          key={n.hash}
                          node={n}
                          row={g.rows[k]}
                          width={PAD * 2 + g.width * LANE}
                          theme={theme}
                          styles={styles}
                          narrow={narrow}
                          rowWidth={narrow ? Math.max(width, PAD * 2 + g.width * LANE + 200) : undefined}
                          now={now}
                          selected={selected?.hash === n.hash}
                          onPress={() => setSelected(selected?.hash === n.hash ? null : { runId: n.runId, hash: n.hash })}
                          onToggle={() => update({ expanded: toggle(state.expanded, n.hash) })}
                        />
                      ))}
                    </View>
                  </ScrollView>
                ) : null}
              </View>
            );
          })}
        </ScrollView>
        {selectedNode ? (
          <Detail
            node={selectedNode}
            run={runs.get(selectedNode.runId) ?? null}
            runs={runs}
            workspacePath={dir}
            theme={theme}
            styles={styles}
            now={now}
            onClose={() => setSelected(null)}
            onSelectRun={(runId) => {
              const hash = findStart(graphs, runId);
              if (hash) setSelected({ runId, hash });
            }}
          />
        ) : null}
      </View>
    </View>
  );
}

function findNode(graphs: Map<string, Graph>, hash: string): GraphNode | null {
  for (const g of graphs.values()) {
    const n = g.nodes.find((x) => x.hash === hash);
    if (n) return n;
  }
  return null;
}

function findStart(graphs: Map<string, Graph>, runId: string): string | null {
  for (const g of graphs.values()) {
    const n = g.nodes.find((x) => x.runId === runId && x.kind === "start");
    if (n) return n.hash;
  }
  return null;
}

function NodeRow(props: {
  node: GraphNode;
  row: Graph["rows"][number];
  width: number;
  theme: PluginTheme;
  styles: Styles;
  now: number;
  selected: boolean;
  narrow: boolean;
  /** Narrow layouts: the row fills this width and the label truncates. */
  rowWidth?: number;
  onPress: () => void;
  onToggle: () => void;
}) {
  const { node: n, row, width, theme, styles, now, selected } = props;
  const badge =
    n.childCount > 0 ? (
      <Pressable accessibilityRole="button" accessibilityLabel={`${n.expanded ? "Collapse" : "Expand"} ${n.childCount} linked runs`} style={styles.badge} onPress={props.onToggle}>
        <Text style={styles.badgeText}>
          {n.expanded ? "▾" : "▸"} {n.childCount} run{n.childCount === 1 ? "" : "s"}
          {n.childLive ? ` · ${n.childLive} live` : ""}
        </Text>
      </Pressable>
    ) : null;
  let body;
  if (n.kind === "item" && n.item) {
    const a = n.item;
    body = (
      <>
        {a.tag ? (
          <View style={[styles.pill, { marginRight: 6 }]}>
            <Text style={styles.small}>{a.tag}</Text>
          </View>
        ) : null}
        <Text style={{ color: a.state === "done" ? theme.colors.foreground : stateColor(theme, a.state), fontSize: 13, flexShrink: 1, maxWidth: props.narrow ? undefined : 420 }} numberOfLines={1}>
          {a.label}
        </Text>
        {badge}
        <Text numberOfLines={1} style={[styles.cell, { color: stateColor(theme, a.state), minWidth: props.narrow ? 0 : 54 }]}>{a.stateText ?? (a.state === "done" ? "" : a.state)}</Text>
        <Text numberOfLines={1} style={[styles.cell, { minWidth: props.narrow ? 0 : 48 }]}>{itemDuration(a.start, a.end, a.state === "running", now)}</Text>
        {props.narrow ? null : <Text style={[styles.cell, { minWidth: 48 }]}>{a.sub}</Text>}
      </>
    );
  } else if (n.kind === "phase") {
    const tag = n.pending ? "pending" : n.running ? `${n.done}/${n.count} · ${n.running} running` : `${n.count} item${n.count === 1 ? "" : "s"}`;
    body = (
      <>
        <Text style={[styles.text, { fontWeight: "600", color: n.pending ? theme.colors.foregroundMuted : theme.colors.foreground }]} numberOfLines={1}>
          {n.title}
        </Text>
        <Text style={[styles.small, { marginLeft: 8 }]}>{tag}</Text>
      </>
    );
  } else if (n.kind === "start") {
    body = (
      <>
        <Text style={styles.muted} numberOfLines={1}>
          ▶ {n.title}
        </Text>
        {n.edge ? (
          <View style={[styles.pill, { marginLeft: 6 }]}>
            <Text style={{ color: n.edge.confidence === "inferred" ? theme.colors.statusWarning : theme.colors.foregroundMuted, fontSize: 10 }}>
              {n.edge.confidence === "inferred" ? `inferred · ${n.edge.evidence}` : n.edge.evidence}
            </Text>
          </View>
        ) : null}
        {badge}
      </>
    );
  } else {
    body = (
      <>
        <Text style={styles.muted}>■ {n.title}</Text>
        {badge}
      </>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={n.title}
      onPress={props.onPress}
      style={[styles.row(selected), props.rowWidth ? { width: props.rowWidth } : null]}
    >
      <LaneCell row={row} node={n} width={width} theme={theme} />
      <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 4, flex: props.rowWidth ? 1 : undefined, minWidth: 0 }}>{body}</View>
    </Pressable>
  );
}

function Detail(props: {
  node: GraphNode;
  run: Run | null;
  runs: Map<string, Run>;
  workspacePath: string;
  theme: PluginTheme;
  styles: Styles;
  now: number;
  onClose: () => void;
  onSelectRun: (runId: string) => void;
}) {
  const { node, run, runs, workspacePath, theme, styles, now } = props;
  const runDetail = useRpc(runDetailRpc);
  const detail = useQuery({
    queryKey: ["run-graph", "detail", workspacePath, node.runId],
    queryFn: () => runDetail({ workspacePath, runId: node.runId }),
    refetchInterval: run?.live ? 3000 : false,
  });
  const full = detail.data?.run ?? null;
  const item: Item | null = node.item ? (full?.agentList.find((a) => a.id === node.item!.id) ?? node.item) : null;
  const parent = run?.parent ? runs.get(run.parent.runId) : null;
  const children = (run?.children ?? []).filter((c) => (item ? c.itemId === item.id : true));
  const block = (title: string, text: string, key: string) => (
    <View key={key}>
      <Text style={styles.blockTitle}>{title}</Text>
      <Text style={styles.mono} selectable>
        {text}
      </Text>
    </View>
  );
  const urls = (item?.blocks ?? []).filter((b) => /^https:\/\/\S+$/.test(b.text));
  return (
    <View style={styles.detail}>
      <View style={{ flexDirection: "row", alignItems: "center", padding: 10, gap: 8, borderBottomWidth: 1, borderColor: theme.colors.border }}>
        <Text style={[styles.text, { fontWeight: "600", flex: 1 }]} numberOfLines={2}>
          {item ? (item.tag ? `${item.tag} · ${item.label}` : item.label) : (run?.name ?? node.title)}
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Close details" onPress={props.onClose}>
          <Text style={styles.muted}>✕</Text>
        </Pressable>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 10, gap: 2 }}>
        {item ? (
          <Text style={{ color: stateColor(theme, item.state), fontSize: 12 }}>
            {[item.stateText ?? item.state, itemDuration(item.start, item.end, item.state === "running", now), ...item.facts].filter(Boolean).join(" · ")}
          </Text>
        ) : run ? (
          <>
            <Text style={{ color: stateColor(theme, runState(run.status)), fontSize: 12 }}>{[SOURCE_LABEL[run.kind], run.status, run.stats].filter(Boolean).join(" · ")}</Text>
            {run.current ? block("current", run.current, "current") : null}
            {[run.location, ...(full?.facts ?? run.facts)].map((f, i) => (
              <Text key={`f${i}`} style={styles.small}>
                {f}
              </Text>
            ))}
            {run.errors.map((e) => (
              <Text key={e} style={styles.error}>
                {e}
              </Text>
            ))}
          </>
        ) : null}
        {node.edge ? block("linked by", `${node.edge.evidence} (${node.edge.confidence}) — ${node.edge.detail}`, "edge") : null}
        {item?.blocks.map((b, i) => block(b.title, b.text, `b${i}`))}
        {urls.map((b) => (
          <Pressable key={b.text} accessibilityRole="link" onPress={() => void openExternalUrl(b.text)}>
            <Text style={styles.link}>{b.text}</Text>
          </Pressable>
        ))}
        {detail.isFetching && item && !item.blocks.length ? <Text style={styles.small}>loading details…</Text> : null}
        {parent && !item ? (
          <>
            <Text style={styles.blockTitle}>parent</Text>
            <Pressable accessibilityRole="link" onPress={() => props.onSelectRun(parent.runId)}>
              <Text style={styles.link}>
                {parent.name}
                {run?.parent?.itemId ? ` · ${run.parent.itemId}` : ""} ({run?.parent?.evidence}, {run?.parent?.confidence})
              </Text>
            </Pressable>
          </>
        ) : null}
        {children.length ? <Text style={styles.blockTitle}>children</Text> : null}
        {children.map((c) => {
          const r = runs.get(c.runId);
          return (
            <Pressable key={c.runId} accessibilityRole="link" onPress={() => props.onSelectRun(c.runId)}>
              <Text style={styles.link}>
                {r ? `${SOURCE_LABEL[r.kind]} ${r.name}` : c.runId} ({c.evidence}
                {c.confidence === "inferred" ? ", inferred" : ""})
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
