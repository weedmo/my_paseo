import type { PluginTheme } from "@getpaseo/plugin";
import { Pressable, Text } from "react-native";
import type { Dataset, Host } from "../shared/rpc";

export function makeStyles(theme: PluginTheme, compact: boolean) {
  const c = theme.colors;
  const card = {
    backgroundColor: c.surface1,
    borderColor: c.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: compact ? 10 : 12,
    gap: 4,
  };
  const chip = { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: c.border };
  return {
    screen: { flex: 1, backgroundColor: c.surface0, padding: compact ? 12 : 20, gap: compact ? 10 : 14 },
    section: { gap: compact ? 10 : 14 },
    h1: { color: c.foreground, fontSize: compact ? 18 : 20, fontWeight: "600" as const },
    h2: { color: c.foreground, fontSize: 15, fontWeight: "600" as const },
    title: { color: c.foreground, fontSize: 14, fontWeight: "600" as const },
    text: { color: c.foreground, fontSize: 13 },
    muted: { color: c.foregroundMuted, fontSize: 12 },
    danger: { color: c.statusDanger, fontSize: 12 },
    success: { color: c.statusSuccess, fontSize: 12, fontWeight: "600" as const },
    row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, alignItems: "center" as const },
    spread: { flexDirection: "row" as const, gap: 8, alignItems: "center" as const, justifyContent: "space-between" as const },
    card,
    cardActive: { ...card, borderColor: c.accent },
    listRow: { ...card, paddingVertical: compact ? 6 : 8 },
    chip: { ...chip, backgroundColor: c.surface1 },
    chipActive: { ...chip, backgroundColor: c.accent, borderColor: c.accent },
    chipText: { color: c.foreground, fontSize: 12 },
    chipTextActive: { color: c.accentForeground, fontSize: 12, fontWeight: "600" as const },
    button: { borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: c.surface2 },
    primary: { borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: c.accent },
    buttonText: { color: c.foreground, fontSize: 12 },
    primaryText: { color: c.accentForeground, fontSize: 12, fontWeight: "600" as const },
    input: {
      flex: 1,
      minWidth: 160,
      color: c.foreground,
      backgroundColor: c.surface0,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 6,
      fontSize: 13,
    },
    list: { gap: 8, paddingBottom: 24 },
    placeholder: c.foregroundMuted,
  };
}
export type Styles = ReturnType<typeof makeStyles>;

export function Button({ styles, label, onPress, primary, disabled, accessibilityLabel }: {
  styles: Styles;
  label: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
  /** Defaults to the label; set it when several buttons share one label. */
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      disabled={disabled}
      onPress={onPress}
      style={[primary ? styles.primary : styles.button, disabled ? { opacity: 0.5 } : null]}
    >
      <Text style={primary ? styles.primaryText : styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

export function HostChips({ styles, hosts, selected, onSelect }: {
  styles: Styles;
  hosts: readonly Host[];
  selected: string | null;
  onSelect: (host: Host) => void;
}) {
  if (hosts.length < 2) return null;
  return (
    <>
      {hosts.map((host) => {
        const active = host.serverId === selected;
        return (
          <Pressable
            key={host.serverId || "self"}
            accessibilityRole="button"
            accessibilityLabel={`Use ${host.label}`}
            accessibilityState={{ selected: active }}
            onPress={() => onSelect(host)}
            style={active ? styles.chipActive : styles.chip}
          >
            <Text style={active ? styles.chipTextActive : styles.chipText}>{hostText(host)}</Text>
          </Pressable>
        );
      })}
    </>
  );
}

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function hostText(host: Host): string {
  if (host.self) return `${host.label} (this computer)`;
  return host.status === "online" ? host.label : `${host.label} (${host.status})`;
}

export function datasetSummary(dataset: Dataset): string {
  const parts = [dataset.version, `${dataset.episodes} episodes`, `${dataset.fps} fps`];
  if (dataset.robotType) parts.push(dataset.robotType);
  if (dataset.cameras.length > 0) parts.push(`${dataset.cameras.length} cameras`);
  return parts.join(" · ");
}
