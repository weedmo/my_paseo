import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { ScrollView, SettingsCard, SettingsInput, SettingsSection } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { type ViewerSettings, viewerSettings } from "../shared/settings";

export function SettingsScreen({ theme }: PluginSurfaceProps) {
  const state = useSettings(viewerSettings);
  if (state.status !== "ready") {
    const text = state.status === "loading" ? "Loading…" : state.error;
    return <Text style={{ color: theme.colors.foregroundMuted, padding: 16 }}>{text}</Text>;
  }
  const { values, revision } = state;
  const save = (patch: Partial<ViewerSettings>) => void state.save({ ...values, ...patch }, revision);
  return (
    <ScrollView>
      <SettingsSection title="Datasets">
        <SettingsCard>
          <SettingsInput
            label="Dataset folders"
            hint="Folders on this host that are always searched, separated by commas. Folders added from the dataset screen are kept per device."
            initialValue={values.roots.join(", ")}
            error={state.saveError}
            onChangeText={(text) => save({ roots: text.split(",").map((part) => part.trim()).filter(Boolean) })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Viewer">
        <SettingsCard>
          <SettingsInput
            label="Python path"
            hint="Python with rerun-sdk, pyarrow, av and pillow. Leave empty to search PATH and conda environments."
            initialValue={values.pythonPath}
            onChangeText={(text) => save({ pythonPath: text.trim() })}
          />
          <SettingsInput
            label="Viewer host name"
            hint="Name this app uses to reach the host machine. Keep localhost when the host is this computer."
            initialValue={values.viewerHost}
            onChangeText={(text) => save({ viewerHost: text.trim() || "localhost" })}
          />
        </SettingsCard>
      </SettingsSection>
    </ScrollView>
  );
}
