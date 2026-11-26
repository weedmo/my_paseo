// A read-only table view for .parquet files opened from a real Paseo workspace's file explorer.
// The host that has the file reads it (pyarrow), one page of rows at a time.
import type { PluginFilePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { View } from "react-native";
import { parquetReadRpc } from "../shared/rpc";
import { ParquetTable } from "./files";
import { makeStyles } from "./style";

export function ParquetPanel({ theme, layout, file }: PluginFilePanelProps) {
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
  const read = useRpc(parquetReadRpc);
  return (
    <View style={styles.screen}>
      <ParquetTable
        styles={styles}
        theme={theme}
        name={file.name}
        cacheKey={[file.path, file.modifiedAt]}
        read={(offset, limit) => read({ path: file.path, offset, limit })}
      />
    </View>
  );
}
