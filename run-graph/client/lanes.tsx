// Draws one row's lane segments and dot with plain Views (no SVG: plugins may
// not import react-native-svg). Straight segments are thin Views; a fork or
// merge between lanes is a View rotated to the angle between its ends. A dashed
// segment is drawn as short pieces.
import type { PluginTheme } from "@getpaseo/plugin";
import { View } from "react-native";
import type { LaneRow } from "../shared/lanes.ts";
import type { GraphNode } from "../shared/graph.ts";
import type { ItemState } from "../shared/model.ts";

export const ROW = 28;
export const LANE = 14;
export const PAD = 8;
const STROKE = 2;

export function laneColors(theme: PluginTheme): string[] {
  const c = theme.colors;
  return [c.accent, c.statusSuccess, c.statusWarning, c.foregroundMuted, c.statusDanger];
}

export function stateColor(theme: PluginTheme, state: ItemState | string): string {
  const c = theme.colors;
  switch (state) {
    case "running":
      return c.accent;
    case "failed":
    case "blocked":
    case "error":
      return c.statusDanger;
    case "stopped":
    case "queued":
      return c.foregroundMuted;
    default:
      return c.statusSuccess;
  }
}

const x = (lane: number) => PAD + lane * LANE + LANE / 2;

function Line(props: { x1: number; y1: number; x2: number; y2: number; color: string; dashed: boolean }) {
  const { x1, y1, x2, y2, color, dashed } = props;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 0.5) return null;
  const angle = Math.atan2(dy, dx);
  const pieces = dashed ? Math.max(1, Math.floor(len / 6)) : 1;
  const out = [];
  for (let i = 0; i < pieces; i++) {
    const t0 = dashed ? i / pieces : 0;
    const segLen = dashed ? (len / pieces) * 0.55 : len;
    const cx = x1 + dx * t0 + Math.cos(angle) * (segLen / 2);
    const cy = y1 + dy * t0 + Math.sin(angle) * (segLen / 2);
    out.push(
      <View
        key={i}
        style={{
          position: "absolute",
          left: cx - segLen / 2,
          top: cy - STROKE / 2,
          width: segLen,
          height: STROKE,
          backgroundColor: color,
          opacity: dashed ? 0.7 : 1,
          transform: [{ rotate: `${angle}rad` }],
        }}
      />,
    );
  }
  return <>{out}</>;
}

export function LaneCell(props: { row: LaneRow; node: GraphNode; width: number; theme: PluginTheme }) {
  const { row, node, width, theme } = props;
  const colors = laneColors(theme);
  const color = (lane: number) => colors[lane % colors.length];
  // Straight lines: vertical within a lane, diagonal where a branch forks or merges.
  const lines = row.segments.map(([a, ya, b, yb, c, dashed], i) => (
    <Line
      key={i}
      x1={x(a)}
      y1={ya * ROW}
      x2={x(b)}
      y2={yb * ROW}
      color={dashed ? theme.colors.foregroundMuted : color(c)}
      dashed={dashed}
    />
  ));
  const big = node.kind !== "item";
  const r = big ? 5 : 4;
  const lane = color(row.lane);
  const state = node.item?.state;
  const dot = big
    ? {
        backgroundColor: theme.colors.surface0,
        borderWidth: 2,
        borderColor: node.kind === "phase" ? (node.pending ? theme.colors.foregroundMuted : lane) : theme.colors.foreground,
      }
    : { backgroundColor: state === "done" ? lane : stateColor(theme, state ?? "queued") };
  return (
    <View style={{ width, height: ROW, overflow: "hidden" }} pointerEvents="none">
      {lines}
      <View
        style={{
          position: "absolute",
          left: x(row.lane) - r,
          top: ROW / 2 - r,
          width: r * 2,
          height: r * 2,
          borderRadius: r,
          ...dot,
        }}
      />
    </View>
  );
}
