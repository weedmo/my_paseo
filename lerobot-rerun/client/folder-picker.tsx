// Browse folders on a host and connect a dataset folder, like opening a project folder.
import { useRpc } from "@getpaseo/plugin/client";
import { Modal, TextInput } from "@getpaseo/plugin/client/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type Dataset, type Host, listFolderRpc } from "../shared/rpc";
import type { Connection } from "../shared/settings";
import { Button, HostChips, type Styles, datasetSummary, message } from "./style";

export type NewConnection = Omit<Connection, "id">;

function crumbs(path: string): { label: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  return [{ label: "/", path: "/" }, ...parts.map((label, i) => ({ label, path: `/${parts.slice(0, i + 1).join("/")}` }))];
}

export function FolderPicker({ styles, open, onOpenChange, hosts, initialServerId, onConnect }: {
  styles: Styles;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hosts: readonly Host[];
  initialServerId: string | null;
  onConnect: (connection: NewConnection) => void;
}) {
  const listFolder = useRpc(listFolderRpc);
  const [serverId, setServerId] = useState<string | null>(initialServerId);
  const [path, setPath] = useState<string | undefined>(undefined);
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (open) setServerId(initialServerId ?? hosts[0]?.serverId ?? null);
  }, [open]);

  const host = hosts.find((entry) => entry.serverId === serverId) ?? hosts[0] ?? null;
  const target = host && !host.self ? host.serverId : undefined;
  const listing = useQuery({
    queryKey: ["lerobot-rerun", "folder", host?.serverId ?? "self", path ?? "~"],
    queryFn: () => listFolder({ serverId: target, path }),
    enabled: open && host !== null,
    staleTime: 30_000,
    // Keep showing the last folder while the next one loads.
    placeholderData: keepPreviousData,
  });
  const data = listing.data;
  useEffect(() => {
    if (data) setTyped(data.path);
  }, [data?.path]);

  const go = (next: string) => setPath(next);
  const connect = (folder: string, name: string, dataset: Dataset | null) => {
    if (!host) return;
    onConnect({
      serverId: host.self ? "" : host.serverId,
      hostLabel: host.label,
      path: folder,
      name,
      kind: dataset ? "dataset" : "collection",
    });
    onOpenChange(false);
  };
  const childDatasets = data?.entries.filter((entry) => entry.dataset).length ?? 0;
  const currentName = data ? data.path.split("/").filter(Boolean).pop() ?? "/" : "";

  return (
    <Modal title="Connect a dataset folder" open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        <View style={styles.row}>
          <HostChips
            styles={styles}
            hosts={hosts}
            selected={host?.serverId ?? null}
            onSelect={(next) => {
              setServerId(next.serverId);
              setPath(undefined);
            }}
          />
        </View>

        <View style={styles.row}>
          <TextInput
            style={styles.input}
            value={typed}
            onChangeText={setTyped}
            onSubmitEditing={() => go(typed)}
            placeholder="/path/to/folder"
            placeholderTextColor={styles.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Folder path"
          />
          <Button styles={styles} label="Go" onPress={() => go(typed)} disabled={!typed.trim()} />
        </View>

        {data ? (
          <View style={styles.row}>
            {data.shortcuts.map((shortcut) => (
              <Pressable
                key={shortcut.path}
                accessibilityRole="button"
                accessibilityLabel={`Go to ${shortcut.label}`}
                onPress={() => go(shortcut.path)}
                style={styles.chip}
              >
                <Text style={styles.chipText}>{shortcut.label}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {data ? (
          <View style={styles.row}>
            {crumbs(data.path).map((crumb, i) => (
              <Pressable key={crumb.path} accessibilityRole="link" accessibilityLabel={`Go to ${crumb.path}`} onPress={() => go(crumb.path)}>
                <Text style={styles.text}>{i > 1 ? `/ ${crumb.label}` : crumb.label}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {listing.isFetching ? <Text style={styles.muted}>Reading folders on {host?.label}…</Text> : null}
        {listing.error ? <Text style={styles.danger}>{message(listing.error)}</Text> : null}

        {data ? (
          <View style={styles.cardActive}>
            <View style={styles.spread}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.title} numberOfLines={1}>{currentName}</Text>
                <Text style={data.dataset ? styles.success : styles.muted}>
                  {data.dataset
                    ? `LeRobot dataset · ${datasetSummary(data.dataset)}`
                    : childDatasets > 0
                      ? `${childDatasets} dataset folder${childDatasets === 1 ? "" : "s"} directly inside; connecting also finds deeper ones`
                      : "No dataset directly here. Connecting searches up to six levels below."}
                </Text>
              </View>
              <Button styles={styles} primary label="Connect this folder" onPress={() => connect(data.path, currentName, data.dataset)} />
            </View>
          </View>
        ) : null}

        {data?.parent ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Go to the parent folder" onPress={() => go(data.parent as string)} style={styles.listRow}>
            <Text style={styles.text}>..</Text>
          </Pressable>
        ) : null}
        {data?.entries.map((entry) => (
          <View key={entry.path} style={[styles.listRow, styles.spread]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open folder ${entry.name}`}
              onPress={() => go(entry.path)}
              style={{ flex: 1, gap: 2 }}
            >
              <Text style={styles.text} numberOfLines={1}>{entry.dataset ? "▣ " : "▸ "}{entry.name}</Text>
              {entry.dataset ? <Text style={styles.success} numberOfLines={1}>{datasetSummary(entry.dataset)}</Text> : null}
            </Pressable>
            {entry.dataset ? (
              <Button
                styles={styles}
                label="Connect"
                accessibilityLabel={`Connect ${entry.name}`}
                onPress={() => connect(entry.path, entry.name, entry.dataset)}
              />
            ) : null}
          </View>
        ))}
        {data && data.entries.length === 0 ? <Text style={styles.muted}>No subfolders.</Text> : null}
        {data?.truncated ? <Text style={styles.muted}>Some folders were not listed or not checked for datasets in time.</Text> : null}
      </Modal.Content>
    </Modal>
  );
}
