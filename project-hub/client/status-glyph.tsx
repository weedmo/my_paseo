import type { PluginTheme, PluginWorkspaceSnapshot } from "@getpaseo/plugin";
import { useEffect, useRef } from "react";
import { Animated, Easing, Platform, View, type ViewStyle } from "react-native";

/**
 * Workspace status marks matching Better Paseo's Tasks board
 * (`client/tasks/cards/status-icon.tsx` and `cards/tokens.ts`):
 * running = blue ring with a turning quarter and a centre dot,
 * needs input = hollow amber ring, attention (ready to review) = green dot,
 * failed = larger red dot. Idle keeps the muted hollow dot.
 *
 * The status hues are Paseo's internal `statusDot*` colours, which the plugin
 * theme does not carry; they are picked by the brightness of `surface0`.
 */

const STATUS_LIGHT = { running: "#268ae0", warning: "#b37824", success: "#299f51", danger: "#f12e2f" } as const;
const STATUS_DARK = { running: "#5caaf6", warning: "#db932e", success: "#35c264", danger: "#f7796d" } as const;

const BOX = 16;
const MARK = 12;
const STROKE = 1.5;
const RING_PERIOD_MS = 900;

function brightness(color: string): number | null {
  const hex = /^#([0-9a-f]{6})/i.exec(color.trim())?.[1];
  if (!hex) {
    const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(color.trim());
    if (!rgb) return null;
    return (0.299 * Number(rgb[1]) + 0.587 * Number(rgb[2]) + 0.114 * Number(rgb[3])) / 255;
  }
  const channel = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
  return (0.299 * channel(0) + 0.587 * channel(2) + 0.114 * channel(4)) / 255;
}

export function statusColors(theme: PluginTheme) {
  const isDark = (brightness(theme.colors.surface0) ?? 0) < 0.5;
  const band = isDark ? STATUS_DARK : STATUS_LIGHT;
  return { ...band, danger: theme.colors.statusDanger || band.danger };
}

const box: ViewStyle = { width: BOX, height: BOX, alignItems: "center", justifyContent: "center" };

function RunningRing({ color }: { color: string }) {
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: RING_PERIOD_MS,
        easing: Easing.linear,
        useNativeDriver: Platform.OS !== "web",
        isInteraction: false,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [spin]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  const circle: ViewStyle = {
    position: "absolute",
    left: 0,
    top: 0,
    width: MARK,
    height: MARK,
    borderRadius: MARK / 2,
    borderWidth: STROKE,
  };
  return (
    <View style={box} accessibilityLabel="Running">
      <View style={{ width: MARK, height: MARK, alignItems: "center", justifyContent: "center" }}>
        <View style={[circle, { borderColor: color, opacity: 0.3 }]} />
        <Animated.View
          style={[circle, { borderColor: "transparent", borderTopColor: color, opacity: 0.9, transform: [{ rotate }] }]}
        />
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
      </View>
    </View>
  );
}

function Dot({ size, color, label }: { size: number; color: string; label: string }) {
  return (
    <View style={box} accessibilityLabel={label}>
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
    </View>
  );
}

export function StatusGlyph({ indicator, theme }: { indicator: PluginWorkspaceSnapshot["indicator"]; theme: PluginTheme }) {
  const status = statusColors(theme);
  switch (indicator) {
    case "running":
      return <RunningRing color={status.running} />;
    case "needs_input":
      return (
        <View style={box} accessibilityLabel="Needs input">
          <View style={{ width: MARK, height: MARK, borderRadius: MARK / 2, borderWidth: STROKE, borderColor: status.warning }} />
        </View>
      );
    case "attention":
      return <Dot size={6} color={status.success} label="Ready to review" />;
    case "failed":
      return <Dot size={8} color={status.danger} label="Failed" />;
    default:
      return (
        <View style={box}>
          <View
            style={{ width: 7, height: 7, borderRadius: 999, borderWidth: 1, borderColor: theme.colors.foregroundMuted, opacity: 0.6 }}
          />
        </View>
      );
  }
}
