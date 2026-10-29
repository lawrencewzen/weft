import { createCredentialStore } from './provider-stores.mjs';
import { migrateSettingsV2toV3, SETTINGS_VERSION_V3 } from './provider-config.mjs';
import { migrateLegacySettings } from './model-sources.mjs';

export const SETTINGS_V2_BACKUP_ID = 'app-v2-backup';

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function errorText(err) {
  return err instanceof Error ? (err.stack || err.message) : String(err);
}

/**
 * Startup v2 → v3 settings migration. Idempotent. Failure rolls back (no v3
 * write) so the next boot retries. The raw JSON is copied to settings id
 * `app-v2-backup` inside the same transaction (existing backup is kept).
 */
export async function migrateAppSettingsToV3(store, { log = console, credentials } = {}) {
  if (!store) throw new Error('store is required');
  const raw = asRecord(await store.getSettingsRaw('app'));
  if (!raw) return { migrated: false };
  if (raw.version === SETTINGS_VERSION_V3) return { migrated: false };

  const v2 = raw.version === 2 ? raw : migrateLegacySettings(raw);
  const credStore = credentials || createCredentialStore(store);

  try {
    await store.withTransaction(async () => {
      await store.putSettingsRaw(SETTINGS_V2_BACKUP_ID, raw, { overwrite: false });
      const { settings, credentials: creds, idMap } = migrateSettingsV2toV3(v2);
      for (const item of creds) {
        await credStore.modify(item.providerId, async () => item.credential);
      }
      await store.remapConversationModelSources(idMap);
      await store.replaceSettings(settings);
    });
    return { migrated: true };
  } catch (err) {
    log.error?.(`WEFT_SETTINGS_MIGRATE_V3 ${errorText(err)}`);
    return { migrated: false, error: err };
  }
}
