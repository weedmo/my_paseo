// Files of a connected folder, shown inside the dataset screen like a workspace: a folder tree,
// and tabs that open text files in an editor and Parquet files as a table.
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { type FileEntry, type ParquetPage, listFilesRpc, readFileRpc, readParquetRpc, writeFileRpc } from "../shared/rpc";
import type { Connection } from "../shared/settings";
import { Button, type Styles, message } from "./style";

const KEY = "lerobot-rerun";

export const fileName = (path: string) => path.split("/").pop() || path;
const isParquet = (path: string) => path.toLowerCase().endsWith(".parquet");
const VIDEO = /\.(mp4|mkv|webm|avi|mov)$/i;

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function target(connection: Connection) {
  return { serverId: connection.serverId || undefined, root: connection.path };
}

/** One folder's entries; folders expand in place. */
function FolderEntries(props: {
  connection: Connection;
  path: string;
  depth: number;
  styles: Styles;
  theme: PluginTheme;
  activePath: string | null;
  onOpenFile: (path: string) => void;
}) {
  const { connection, path, depth, styles, theme, activePath, onOpenFile } = props;
  const listFiles = useRpc(listFilesRpc);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const listing = useQuery({
    queryKey: [KEY, "files", connection.serverId, connection.path, path],
    queryFn: () => listFiles({ ...target(connection), path }),
    staleTime: 30_000,
  });
  const pad = 8 + depth * 14;
  const row = (active: boolean) => ({
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
    paddingVertical: 3,
    paddingLeft: pad,
    paddingRight: 8,
    borderRadius: 4,
    backgroundColor: active ? theme.colors.surface2 : "transparent",
  });
  if (listing.isLoading) return <Text style={[styles.muted, { paddingLeft: pad }]}>Loading…</Text>;
  if (listing.error) return <Text style={[styles.danger, { paddingLeft: pad }]}>{message(listing.error)}</Text>;
  return (
    <>
      {(listing.data?.entries ?? []).map((entry: FileEntry) =>
        entry.kind === "folder" ? (
          <View key={entry.path}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${open[entry.path] ? "Collapse" : "Expand"} folder ${entry.name}`}
              onPress={() => setOpen({ ...open, [entry.path]: !open[entry.path] })}
              style={row(false)}
            >
              <Text style={styles.muted}>{open[entry.path] ? "▾" : "▸"}</Text>
              <Text style={styles.text} numberOfLines={1}>{entry.name}</Text>
            </Pressable>
            {open[entry.path] ? <FolderEntries {...props} path={entry.path} depth={depth + 1} /> : null}
          </View>
        ) : (
          <Pressable
            key={entry.path}
            accessibilityRole="button"
            accessibilityLabel={`Open file ${entry.name}`}
            onPress={() => onOpenFile(entry.path)}
            style={row(activePath === entry.path)}
          >
            <Text style={styles.muted}> </Text>
            <Text style={[styles.text, { flex: 1 }]} numberOfLines={1}>{entry.name}</Text>
            <Text style={styles.muted}>{sizeText(entry.size)}</Text>
          </Pressable>
        ),
      )}
      {listing.data?.truncated ? <Text style={[styles.muted, { paddingLeft: pad }]}>Only the first 2000 entries are listed.</Text> : null}
    </>
  );
}

export function FileTree(props: {
  connection: Connection;
  styles: Styles;
  theme: PluginTheme;
  activePath: string | null;
  onOpenFile: (path: string) => void;
}) {
  const queryClient = useQueryClient();
  return (
    <View style={{ flex: 1, gap: 4 }}>
      <View style={props.styles.spread}>
        <Text style={props.styles.title}>Files</Text>
        <Button
          styles={props.styles}
          label="Reload"
          accessibilityLabel="Reload the file tree"
          onPress={() => void queryClient.invalidateQueries({ queryKey: [KEY, "files", props.connection.serverId, props.connection.path] })}
        />
      </View>
      <ScrollView style={{ flex: 1 }}>
        <FolderEntries {...props} path="." depth={0} />
      </ScrollView>
    </View>
  );
}

/** A read-only page-by-page table of a Parquet file. */
export function ParquetTable({ styles, theme, name, read, cacheKey }: {
  styles: Styles;
  theme: PluginTheme;
  name: string;
  read: (offset: number, limit: number) => Promise<ParquetPage>;
  cacheKey: readonly unknown[];
}) {
  const PAGE = 100;
  const [offset, setOffset] = useState(0);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const page = useQuery({
    queryKey: [KEY, "parquet", ...cacheKey, offset],
    queryFn: () => read(offset, PAGE),
    placeholderData: keepPreviousData,
  });
  const data = page.data;
  const total = data?.numRows ?? 0;
  const last = Math.max(0, Math.floor((total - 1) / PAGE) * PAGE);
  const c = theme.colors;
  const cell = { color: c.foreground, fontSize: 12, width: 180, paddingHorizontal: 6, paddingVertical: 4 };
  const head = { ...cell, fontWeight: "600" as const };
  const index = { ...cell, width: 72, color: c.foregroundMuted, textAlign: "right" as const };
  return (
    <View style={{ flex: 1, gap: 8 }}>
      <View style={styles.spread}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.title} numberOfLines={1}>{name}</Text>
          <Text style={styles.muted}>
            {data
              ? `${total.toLocaleString()} rows · ${data.columns.length} columns · ${data.rowGroups} row group${data.rowGroups === 1 ? "" : "s"} · read only`
              : page.isLoading
                ? "Reading…"
                : ""}
          </Text>
        </View>
        <Button styles={styles} label={schemaOpen ? "Hide schema" : "Schema"} onPress={() => setSchemaOpen(!schemaOpen)} />
      </View>
      {page.error ? <Text style={styles.danger}>{message(page.error)}</Text> : null}
      {schemaOpen && data ? (
        <View style={[styles.card, { maxHeight: 240 }]}>
          <ScrollView>
            {data.columns.map((column) => (
              <Text key={column.name} style={styles.text} selectable>
                {column.name} <Text style={styles.muted}>{column.type}</Text>
              </Text>
            ))}
            {Object.entries(data.metadata).map(([key, value]) => (
              <Text key={key} style={styles.muted} selectable numberOfLines={3}>
                {key}: {value}
              </Text>
            ))}
          </ScrollView>
        </View>
      ) : null}
      {data ? (
        <View style={styles.row}>
          <Button styles={styles} label="First" onPress={() => setOffset(0)} disabled={offset === 0} />
          <Button styles={styles} label="Previous" onPress={() => setOffset(Math.max(0, offset - PAGE))} disabled={offset === 0} />
          <Text style={styles.muted}>
            Rows {total === 0 ? 0 : offset + 1}–{Math.min(offset + PAGE, total)} of {total.toLocaleString()}
            {page.isFetching ? " · loading" : ""}
          </Text>
          <Button styles={styles} label="Next" onPress={() => setOffset(Math.min(last, offset + PAGE))} disabled={offset >= last} />
          <Button styles={styles} label="Last" onPress={() => setOffset(last)} disabled={offset >= last} />
        </View>
      ) : null}
      {data ? (
        <ScrollView horizontal style={{ flex: 1 }}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", borderBottomWidth: 1, borderColor: c.border }}>
              <Text style={index}>#</Text>
              {data.columns.map((column) => (
                <Text key={column.name} style={head} numberOfLines={1} accessibilityLabel={`${column.name}, ${column.type}`}>
                  {column.name}
                </Text>
              ))}
            </View>
            <ScrollView style={{ flex: 1 }}>
              {data.rows.map((row, i) => (
                <View key={data.offset + i} style={{ flexDirection: "row", backgroundColor: i % 2 ? c.surface1 : c.surface0 }}>
                  <Text style={index}>{data.offset + i}</Text>
                  {row.map((value, j) => (
                    <Text key={j} style={cell} numberOfLines={2} selectable>
                      {value}
                    </Text>
                  ))}
                </View>
              ))}
            </ScrollView>
          </View>
        </ScrollView>
      ) : null}
    </View>
  );
}

/** A text file in an editor that saves back to the host. */
function TextFileTab({ connection, path, styles, theme, onDirty }: {
  connection: Connection;
  path: string;
  styles: Styles;
  theme: PluginTheme;
  onDirty: (dirty: boolean) => void;
}) {
  const readFile = useRpc(readFileRpc);
  const writeFile = useRpc(writeFileRpc);
  const file = useQuery({
    queryKey: [KEY, "file", connection.serverId, connection.path, path],
    queryFn: () => readFile({ ...target(connection), path }),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [text, setText] = useState<string | null>(null);
  const [baseMs, setBaseMs] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    if (file.data && text === null) {
      setText(file.data.text);
      setBaseMs(file.data.modifiedMs);
    }
  }, [file.data]);
  const dirty = text !== null && file.data !== undefined && text !== file.data.text;
  useEffect(() => onDirty(dirty), [dirty]);

  const save = async (force: boolean) => {
    if (text === null) return;
    setSaving(true);
    setError(null);
    try {
      const result = await writeFile({ ...target(connection), path, text, expectedModifiedMs: baseMs, force });
      setBaseMs(result.modifiedMs);
      setConflict(false);
      await file.refetch();
    } catch (cause) {
      const reason = message(cause);
      if (reason.includes("CONFLICT")) setConflict(true);
      else setError(reason);
    } finally {
      setSaving(false);
    }
  };
  const reload = async () => {
    const fresh = await file.refetch();
    if (fresh.data) {
      setText(fresh.data.text);
      setBaseMs(fresh.data.modifiedMs);
    }
    setConflict(false);
  };

  if (file.isLoading) return <Text style={styles.muted}>Reading {fileName(path)}…</Text>;
  if (file.error) return <Text style={styles.danger}>{message(file.error)}</Text>;
  const data = file.data;
  if (!data) return null;
  if (data.binary) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>{fileName(path)}</Text>
        <Text style={styles.muted}>
          Binary file, {sizeText(data.size)}.{VIDEO.test(path) ? " Videos play through the episode viewer." : " It cannot be shown as text."}
        </Text>
      </View>
    );
  }
  const readOnly = data.truncated;
  return (
    <View style={{ flex: 1, gap: 8 }}>
      <View style={styles.spread}>
        <Text style={styles.muted}>
          {path} · {sizeText(data.size)}
          {readOnly ? " · read only: only the first 2 MB is shown" : dirty ? " · unsaved changes" : ""}
        </Text>
        {readOnly ? null : (
          <View style={styles.row}>
            <Button styles={styles} label="Revert" onPress={() => setText(data.text)} disabled={!dirty || saving} />
            <Button styles={styles} primary label={saving ? "Saving…" : "Save"} onPress={() => void save(false)} disabled={!dirty || saving} />
          </View>
        )}
      </View>
      {conflict ? (
        <View style={[styles.card, { borderColor: theme.colors.statusDanger }]}>
          <Text style={styles.danger}>The file changed on {connection.hostLabel} after it was opened.</Text>
          <View style={styles.row}>
            <Button styles={styles} label="Reload and lose my changes" onPress={() => void reload()} />
            <Button styles={styles} label="Overwrite with my version" onPress={() => void save(true)} />
          </View>
        </View>
      ) : null}
      {error ? <Text style={styles.danger}>{error}</Text> : null}
      <TextInput
        value={text ?? ""}
        onChangeText={setText}
        editable={!readOnly}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        accessibilityLabel={`Contents of ${fileName(path)}`}
        style={{
          flex: 1,
          minHeight: 240,
          color: theme.colors.foreground,
          backgroundColor: theme.colors.surface1,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 6,
          padding: 10,
          // On web a bare "monospace" is not applied by react-native-web; list real fonts.
          fontFamily: Platform.OS === "web" ? "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace" : "monospace",
          fontSize: 12,
          textAlignVertical: "top",
        }}
      />
    </View>
  );
}

/** The content of one file tab. */
export function FileTab(props: {
  connection: Connection;
  path: string;
  styles: Styles;
  theme: PluginTheme;
  onDirty: (dirty: boolean) => void;
}) {
  const readParquet = useRpc(readParquetRpc);
  const { connection, path } = props;
  if (isParquet(path)) {
    return (
      <ParquetTable
        styles={props.styles}
        theme={props.theme}
        name={path}
        cacheKey={[connection.serverId, connection.path, path]}
        read={(offset, limit) => readParquet({ ...target(connection), path, offset, limit })}
      />
    );
  }
  return <TextFileTab {...props} />;
}
