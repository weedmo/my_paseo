import { openExternalUrl, useRpc, type PluginHostSummary, type PluginSidebarViewProps } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { removeProjects, renameProjects } from "../shared/projects";
import type { CheckoutEntry, RepoGroup } from "./grouping";

type Theme = PluginSidebarViewProps["theme"];

interface Target {
  readonly serverId: string;
  readonly projectId: string;
}

interface Checkout {
  readonly target: Target;
  readonly hostLabel: string;
  readonly online: boolean;
  readonly entry: CheckoutEntry;
}

export function ProjectSettingsModal(props: {
  group: RepoGroup;
  hostsById: ReadonlyMap<string, PluginHostSummary>;
  open: boolean;
  onOpenChange(open: boolean): void;
  onChanged(): void;
  theme: Theme;
}) {
  const { group, theme } = props;
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const toast = useToast();
  const rename = useRpc(renameProjects);
  const remove = useRpc(removeProjects);

  const checkouts = useMemo<Checkout[]>(
    () =>
      group.hosts.flatMap((host) => {
        const summary = props.hostsById.get(host.hostId);
        return host.checkouts.map((entry) => ({
          target: { serverId: host.hostId, projectId: entry.project.projectId },
          hostLabel: summary?.label ?? host.hostId,
          online: summary?.status === "online",
          entry,
        }));
      }),
    [group, props.hostsById],
  );
  const currentCustom = checkouts.find((checkout) => checkout.entry.project.customName)?.entry.project.customName ?? "";
  const [name, setName] = useState(currentCustom);
  const [confirming, setConfirming] = useState<string | null>(null);

  const report = (verb: string, results: readonly { ok: boolean; serverId: string; error?: string }[]) => {
    const failed = results.filter((result) => !result.ok);
    if (failed.length === 0) {
      toast.show(`${verb} on ${results.length} host project${results.length === 1 ? "" : "s"}`, { variant: "success" });
    } else {
      const label = (id: string) => props.hostsById.get(id)?.label ?? id;
      toast.error(`${verb} failed on ${failed.map((result) => `${label(result.serverId)}: ${result.error ?? "error"}`).join("; ")}`);
    }
    props.onChanged();
  };

  const renameMutation = useMutation({
    mutationFn: (customName: string | null) =>
      rename({ targets: checkouts.filter((c) => c.online).map((c) => c.target), customName }),
    onSuccess: ({ results }) => report("Renamed", results),
    onError: (error) => toast.error(String(error instanceof Error ? error.message : error)),
  });
  const removeMutation = useMutation({
    mutationFn: (targets: Target[]) => remove({ targets }),
    onSuccess: ({ results }) => {
      setConfirming(null);
      report("Removed", results);
      if (results.every((result) => result.ok) && results.length === checkouts.length) props.onOpenChange(false);
    },
    onError: (error) => toast.error(String(error instanceof Error ? error.message : error)),
  });

  const busy = renameMutation.isPending || removeMutation.isPending;
  const onlineTargets = checkouts.filter((c) => c.online).map((c) => c.target);
  const totalWorkspaces = group.workspaceCount;
  const githubUrl = group.forge === "github.com" && group.owner && group.repoName
    ? `https://github.com/${group.owner}/${group.repoName}`
    : null;

  return (
    <Modal title="Project settings" open={props.open} onOpenChange={props.onOpenChange}>
      <Modal.Content>
        <View style={styles.section}>
          <Text style={styles.heading}>Repository</Text>
          <Text style={styles.value} selectable>
            {group.isRemote ? `${group.forge}/${group.owner}/${group.repoName}` : "No git remote (host-local directory)"}
          </Text>
          {githubUrl ? (
            <Button label="Open on GitHub" icon="ExternalLink" onPress={() => void openExternalUrl(githubUrl)} styles={styles} theme={theme} />
          ) : null}
        </View>

        <View style={styles.section}>
          <Text style={styles.heading}>Display name</Text>
          <Text style={styles.hint}>Saved as the Paseo project name on every online host that has this repository.</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder={group.repoName ?? group.title}
            placeholderTextColor={theme.colors.foregroundMuted}
            style={styles.input}
            editable={!busy}
          />
          <View style={styles.buttons}>
            <Button
              label="Save"
              disabled={busy || name.trim() === currentCustom || onlineTargets.length === 0}
              onPress={() => renameMutation.mutate(name.trim() || null)}
              styles={styles}
              theme={theme}
              primary
            />
            <Button
              label="Reset to repository name"
              disabled={busy || !currentCustom}
              onPress={() => {
                setName("");
                renameMutation.mutate(null);
              }}
              styles={styles}
              theme={theme}
            />
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.heading}>Checkouts</Text>
          {checkouts.map((checkout) => {
            const key = `${checkout.target.serverId}:${checkout.target.projectId}`;
            const count = checkout.entry.workspaceIds.length;
            return (
              <View key={key} style={styles.checkout}>
                <View style={styles.checkoutText}>
                  <Text style={styles.value} numberOfLines={1}>
                    {checkout.hostLabel}
                    {checkout.online ? "" : " (offline)"}
                  </Text>
                  <Text style={styles.hint} numberOfLines={1} selectable>
                    {checkout.entry.project.rootPath} · {count} workspace{count === 1 ? "" : "s"}
                  </Text>
                </View>
                <Button
                  label={confirming === key ? "Confirm remove" : "Remove"}
                  danger={confirming === key}
                  disabled={busy || !checkout.online}
                  onPress={() =>
                    confirming === key ? removeMutation.mutate([checkout.target]) : setConfirming(key)
                  }
                  styles={styles}
                  theme={theme}
                />
              </View>
            );
          })}
        </View>

        {checkouts.length > 1 ? (
          <View style={styles.section}>
            <Text style={styles.heading}>Remove from all hosts</Text>
            <Text style={styles.hint}>
              Removes this repository from Paseo on {checkouts.length} host projects. Files on disk are not changed;
              its {totalWorkspaces} workspace{totalWorkspaces === 1 ? " is" : "s are"} archived.
            </Text>
            <View style={styles.buttons}>
              <Button
                label={confirming === "all" ? "Confirm remove from all hosts" : "Remove from all hosts"}
                danger
                disabled={busy || onlineTargets.length !== checkouts.length}
                onPress={() => (confirming === "all" ? removeMutation.mutate(onlineTargets) : setConfirming("all"))}
                styles={styles}
                theme={theme}
              />
            </View>
            {onlineTargets.length !== checkouts.length ? (
              <Text style={styles.hint}>Every host must be online to remove from all of them.</Text>
            ) : null}
          </View>
        ) : (
          <Text style={styles.hint}>
            Remove takes the project out of Paseo. Files on disk are not changed; its workspaces are archived.
          </Text>
        )}
      </Modal.Content>
    </Modal>
  );
}

function Button(props: {
  label: string;
  icon?: string;
  onPress(): void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
  styles: Styles;
  theme: Theme;
}) {
  const { styles, theme } = props;
  const color = props.primary ? theme.colors.accentForeground : props.danger ? theme.colors.statusDanger : theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.button,
        props.primary && styles.buttonPrimary,
        props.danger && styles.buttonDanger,
        pressed && styles.buttonPressed,
        props.disabled && styles.buttonDisabled,
      ]}
    >
      {props.icon ? <Icon name={props.icon} size={14} color={color} /> : null}
      <Text style={[styles.buttonText, { color }]}>{props.label}</Text>
    </Pressable>
  );
}

type Styles = ReturnType<typeof makeStyles>;

function makeStyles(theme: Theme) {
  const c = theme.colors;
  return {
    section: { gap: 8 },
    heading: { color: c.foreground, fontSize: 14, fontWeight: "600" as const },
    value: { color: c.foreground, fontSize: 14 },
    hint: { color: c.foregroundMuted, fontSize: 12 },
    input: {
      color: c.foreground,
      fontSize: 14,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      backgroundColor: c.surface1,
    },
    buttons: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
    checkout: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 12,
      paddingVertical: 8,
      paddingHorizontal: 12,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
    },
    checkoutText: { flex: 1, minWidth: 0, gap: 2 },
    button: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      alignSelf: "flex-start" as const,
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface1,
    },
    buttonPrimary: { backgroundColor: c.accent, borderColor: c.accent },
    buttonDanger: { borderColor: c.statusDanger },
    buttonPressed: { opacity: 0.8 },
    buttonDisabled: { opacity: 0.45 },
    buttonText: { fontSize: 13 },
  };
}
