import { useMemo, useState } from "react";
import type { CatalogModel } from "./catalog.js";
import { providerById } from "./catalog.js";
import { FileBar } from "./components/file-bar.js";
import { JsonPreview } from "./components/json-preview.js";
import { ProviderScreen } from "./components/provider-screen.js";
import { ProvidersScreen } from "./components/providers-screen.js";
import type { ConnectionsConfig, ProviderKey, Tier } from "./config.js";
import {
  addKey,
  emptyConfig,
  moveKey,
  parseConfig,
  removeKey,
  serializeConfig,
  updateKey,
} from "./config.js";
import type { ConfigFile } from "./file-store.js";
import {
  createConfigFile,
  DEFAULT_FILE_NAME,
  openConfigFile,
  saveAsConfigFile,
  supportsFileSystemAccess,
} from "./file-store.js";

export function App() {
  const [config, setConfig] = useState<ConnectionsConfig>(emptyConfig);
  const [file, setFile] = useState<ConfigFile | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string | null>(
    supportsFileSystemAccess()
      ? "Open a config file, or start editing this empty draft and save it to a new one."
      : "This browser has no File System Access API: files are read via a file dialog and saved as downloads.",
  );
  const [providerId, setProviderId] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(true);
  /**
   * Live model lists returned by a successful Test, keyed by provider id.
   * Session-only — the config file records *which* models a key is scoped to,
   * never the catalog itself.
   */
  const [discovered, setDiscovered] = useState<Record<string, CatalogModel[]>>({});

  const serialized = useMemo(() => serializeConfig(config), [config]);
  const provider = providerId ? providerById(providerId) : undefined;

  function edit(next: ConnectionsConfig) {
    setConfig(next);
    setDirty(true);
  }

  async function handleOpen() {
    const picked = await openConfigFile();
    if (!picked) return;
    const { config: parsed, warnings } = parseConfig(await picked.read());
    setFile(picked);
    setConfig(parsed);
    setDirty(false);
    setProviderId(null);
    setStatus(warnings.length > 0 ? `Loaded ${picked.name}. ${warnings.join(" ")}` : null);
  }

  async function handleNew() {
    const created = await createConfigFile();
    if (!created) return;
    const fresh = emptyConfig();
    setFile(created);
    setConfig(fresh);
    setProviderId(null);
    if (created.canWriteInPlace) {
      // Write immediately so the file exists on disk with a valid empty config.
      await created.write(serializeConfig(fresh));
      setDirty(false);
      setStatus(`Created ${created.name}.`);
    } else {
      // Downloading an empty config would just be noise — wait for a real Save.
      setDirty(true);
      setStatus(`New draft (${created.name}); Save downloads it.`);
    }
  }

  async function handleSave() {
    if (!file) return handleSaveAs();
    await file.write(serialized);
    setDirty(false);
    setStatus(file.canWriteInPlace ? `Saved to ${file.name}.` : `Downloaded ${file.name} (copy).`);
  }

  async function handleSaveAs() {
    const target = await saveAsConfigFile(file?.name ?? DEFAULT_FILE_NAME);
    if (!target) return;
    await target.write(serialized);
    setFile(target);
    setDirty(false);
    setStatus(target.canWriteInPlace ? `Saved to ${target.name}.` : `Downloaded ${target.name}.`);
  }

  return (
    <div className={previewOpen ? "pr-[28rem]" : undefined}>
      <FileBar
        file={file}
        dirty={dirty}
        status={status}
        previewOpen={previewOpen}
        onOpen={handleOpen}
        onNew={handleNew}
        onSave={handleSave}
        onSaveAs={handleSaveAs}
        onTogglePreview={() => setPreviewOpen((open) => !open)}
      />

      {provider ? (
        <ProviderScreen
          provider={provider}
          models={discovered[provider.id] ?? provider.models}
          config={config}
          dirty={dirty}
          onModelsDiscovered={(models) =>
            setDiscovered((current) => ({ ...current, [provider.id]: models }))
          }
          onBack={() => setProviderId(null)}
          onSave={handleSave}
          onAddKey={(tier: Tier) => edit(addKey(config, provider.id, tier))}
          onUpdateKey={(keyId: string, patch: Partial<ProviderKey>) =>
            edit(updateKey(config, provider.id, keyId, patch))
          }
          onRemoveKey={(keyId: string) => edit(removeKey(config, provider.id, keyId))}
          onMoveKey={(keyId: string, to: Tier) => edit(moveKey(config, provider.id, keyId, to))}
        />
      ) : (
        <ProvidersScreen config={config} onOpenProvider={setProviderId} />
      )}

      {previewOpen && <JsonPreview text={serialized} />}
    </div>
  );
}
