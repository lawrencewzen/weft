import { useState } from 'react';
import { installPlugin, patchPlugin, type Plugin } from '../../data/api';
import type { Lang } from '../../data/lang';
import { useExtensions } from '../../data/useExtensions';
import { t, type I18nKey } from '../../i18n';

type Props = {
  lang: Lang;
  onToast: (message: string) => void;
};

function failText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sourceKey(source: string): I18nKey {
  if (source === 'bundled' || source === 'builtin') return 'plugin_source_builtin';
  if (source === 'community') return 'plugin_source_community';
  return 'plugin_source_local';
}

function initial(plugin: Plugin): string {
  const ch = (plugin.name || plugin.id || '?').trim().charAt(0);
  return ch ? ch.toUpperCase() : '?';
}

export function PluginsPage({ lang, onToast }: Props) {
  const { plugins, ready } = useExtensions();
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function importPlugin() {
    const dir = path.trim();
    if (!dir) {
      setError(t(lang, 'err_plugin_path_required'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const plugin = await installPlugin({ path: dir }, lang);
      setPath('');
      onToast(t(lang, 'plugin_imported', { name: plugin.name || plugin.id }));
    } catch (err) {
      setError(failText(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(plugin: Plugin) {
    try {
      await patchPlugin(plugin.id, { enabled: !plugin.enabled }, lang);
    } catch (err) {
      onToast(failText(err));
    }
  }

  return (
    <div className="next-settings-content" data-testid="next-settings-plugins">
      <div className="next-settings-head">
        <div>
          <h2>{t(lang, 'plugin_title')}</h2>
          <p className="next-settings-sub">{t(lang, 'plugin_subtitle')}</p>
        </div>
      </div>
      <div className="ns-import-row">
        <input
          className="ns-input is-mono"
          data-testid="next-plugin-path"
          value={path}
          placeholder={t(lang, 'plugin_path_placeholder')}
          spellCheck={false}
          autoComplete="off"
          onChange={(ev) => {
            setPath(ev.target.value);
            if (error) setError('');
          }}
        />
        <button
          type="button"
          className="ns-btn ns-btn-primary"
          data-testid="next-plugin-import"
          disabled={busy}
          onClick={() => { void importPlugin(); }}
        >
          {t(lang, 'plugin_import')}
        </button>
      </div>
      <p className="ns-field-hint">{t(lang, 'plugin_path_hint')}</p>
      {error ? (
        <div className="ns-inline-err" data-testid="next-plugin-error">{error}</div>
      ) : null}
      {!ready ? (
        <div className="ns-empty">{t(lang, 'loading')}</div>
      ) : plugins.length === 0 ? (
        <div className="ns-empty">{t(lang, 'plugin_none')}</div>
      ) : (
        <div className="ns-card-grid">
          {plugins.map((plugin) => (
            <div
              key={plugin.id}
              className="ns-ext-card"
              data-testid="next-plugin-row"
              data-id={plugin.id}
            >
              <div className="ns-ext-card-top">
                <span className="ns-ext-mark">{initial(plugin)}</span>
                <b>{plugin.name}</b>
                <button
                  type="button"
                  className={`ns-switch${plugin.enabled ? ' is-on' : ''}`}
                  data-testid="next-plugin-toggle"
                  aria-pressed={plugin.enabled}
                  onClick={() => { void toggle(plugin); }}
                />
              </div>
              <div className="ns-ext-desc">{plugin.description}</div>
              {plugin.error ? (
                <div className="ns-why" data-testid="next-plugin-fail">{plugin.error}</div>
              ) : null}
              <div className="ns-ext-meta">
                <span>{t(lang, sourceKey(plugin.source))}</span>
                <span>·</span>
                <span>{plugin.version}</span>
                {plugin.tools.length ? (
                  <>
                    <span>·</span>
                    <span>{plugin.tools.map((tool) => tool.name).join(', ')}</span>
                  </>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
