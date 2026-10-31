import { useEffect, useRef, useState } from 'react';
import {
  detectGlab,
  getGlabSettings,
  patchGlabSettings,
  testGlab,
  type GlabSettings,
  type GlabTestResult,
} from '../../data/api';
import { hostLabel } from '../../data/gitSettings';
import type { Lang } from '../../data/lang';
import { navigate, settingsPath } from '../../data/nav';
import type { SettingsPage } from '../../data/settingsPages';
import { useExtensions } from '../../data/useExtensions';
import { t } from '../../i18n';

type Props = {
  lang: Lang;
  onToast: (message: string) => void;
  onNavigate?: (page: SettingsPage) => void;
};

function failText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const DEFAULT_SETTINGS: GlabSettings = {
  enabled: false,
  customPath: '',
  binary: {
    source: 'bundled',
    version: '1.46.1',
    path: '/usr/local/bin/glab',
  },
  connectionIds: [],
  defaultConnectionId: null,
};

export function GlabPage({ lang, onToast, onNavigate }: Props) {
  const { gitConnections, ready } = useExtensions();
  const [settings, setSettings] = useState<GlabSettings>(DEFAULT_SETTINGS);
  const settingsRef = useRef<GlabSettings>(DEFAULT_SETTINGS);
  settingsRef.current = settings;
  const patchSeqRef = useRef(0);

  const [customPath, setCustomPath] = useState('');
  const [showCustomPath, setShowCustomPath] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<GlabTestResult | null>(null);

  useEffect(() => {
    let alive = true;
    void getGlabSettings(lang)
      .then((data) => {
        if (!alive) return;
        settingsRef.current = data;
        setSettings(data);
        setCustomPath(data.customPath || '');
        if (data.customPath) setShowCustomPath(true);
      })
      .catch((err) => {
        if (alive) onToast(failText(err));
      });
    return () => {
      alive = false;
    };
  }, [lang, onToast]);

  const gitlabConnections = gitConnections.filter(
    (conn) => conn.kind === 'gitlab-self' || conn.kind === 'gitlab-com',
  );

  const checkedCount = settings.connectionIds.length;

  async function toggleEnabled() {
    const prev = settingsRef.current;
    const nextSettings: GlabSettings = {
      ...prev,
      enabled: !prev.enabled,
    };
    settingsRef.current = nextSettings;
    setSettings(nextSettings);

    const seq = ++patchSeqRef.current;
    try {
      const updated = await patchGlabSettings({ enabled: nextSettings.enabled }, lang);
      if (seq === patchSeqRef.current) {
        settingsRef.current = updated;
        setSettings(updated);
      }
    } catch (err) {
      if (seq === patchSeqRef.current) {
        settingsRef.current = prev;
        setSettings(prev);
      }
      onToast(failText(err));
    }
  }

  async function handleDetect() {
    setDetecting(true);
    try {
      if (customPath !== settingsRef.current.customPath) {
        await patchGlabSettings({ customPath }, lang);
      }
      const updated = await detectGlab(lang);
      settingsRef.current = updated;
      setSettings(updated);
      setCustomPath(updated.customPath || '');
    } catch (err) {
      onToast(failText(err));
    } finally {
      setDetecting(false);
    }
  }

  async function handlePathBlur() {
    if (customPath === settingsRef.current.customPath) return;
    try {
      const updated = await patchGlabSettings({ customPath }, lang);
      settingsRef.current = updated;
      setSettings(updated);
    } catch (err) {
      onToast(failText(err));
    }
  }

  async function toggleConn(id: string) {
    const prev = settingsRef.current;
    const current = new Set(prev.connectionIds);
    if (current.has(id)) {
      current.delete(id);
    } else {
      current.add(id);
    }
    const nextIds = Array.from(current);
    let nextDefault = prev.defaultConnectionId;
    if (!nextIds.includes(nextDefault || '')) {
      nextDefault = nextIds[0] || null;
    }
    const nextSettings: GlabSettings = {
      ...prev,
      connectionIds: nextIds,
      defaultConnectionId: nextDefault,
    };
    settingsRef.current = nextSettings;
    setSettings(nextSettings);

    const seq = ++patchSeqRef.current;
    try {
      const updated = await patchGlabSettings(
        {
          connectionIds: nextIds,
          defaultConnectionId: nextDefault,
        },
        lang,
      );
      if (seq === patchSeqRef.current) {
        settingsRef.current = updated;
        setSettings(updated);
      }
    } catch (err) {
      if (seq === patchSeqRef.current) {
        settingsRef.current = prev;
        setSettings(prev);
      }
      onToast(failText(err));
    }
  }

  async function selectDefault(id: string) {
    const prev = settingsRef.current;
    const nextSettings: GlabSettings = {
      ...prev,
      defaultConnectionId: id,
    };
    settingsRef.current = nextSettings;
    setSettings(nextSettings);

    const seq = ++patchSeqRef.current;
    try {
      const updated = await patchGlabSettings(
        {
          defaultConnectionId: id,
        },
        lang,
      );
      if (seq === patchSeqRef.current) {
        settingsRef.current = updated;
        setSettings(updated);
      }
    } catch (err) {
      if (seq === patchSeqRef.current) {
        settingsRef.current = prev;
        setSettings(prev);
      }
      onToast(failText(err));
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testGlab(lang);
      setTestResult(res);
    } catch (err) {
      setTestResult({
        ok: false,
        host: '',
        username: '',
        output: failText(err),
      });
    } finally {
      setTesting(false);
    }
  }

  function handleGotoGit() {
    if (onNavigate) {
      onNavigate('git');
    } else {
      navigate(settingsPath('git'), { replace: true });
    }
  }

  const binary = settings.binary;
  const isMissing = binary.source === 'missing';
  const sourceLabel =
    binary.source === 'bundled'
      ? t(lang, 'glab_source_bundled')
      : binary.source === 'custom'
        ? t(lang, 'glab_source_custom')
        : t(lang, 'glab_source_missing');

  return (
    <div className="next-settings-content ns-git-page" data-testid="next-settings-glab">
      <div className="next-settings-head">
        <div>
          <h2>{t(lang, 'glab_title')}</h2>
          <p className="next-settings-sub">{t(lang, 'glab_lead')}</p>
        </div>
      </div>

      <div className="ns-git-scroll">
        <div className="ns-glab-status-row">
          <div className="ns-glab-status-main">
            <span className={`ns-dot ${isMissing ? 'is-bad' : 'is-ok'}`} />
            <b>{t(lang, 'glab_status_title')}</b>
            <span className="ns-tag is-key">{sourceLabel}</span>
            {isMissing ? (
              <span className="ns-why">{t(lang, 'glab_binary_missing_desc')}</span>
            ) : (
              <span className="mono">{binary.version ? `v${binary.version}` : binary.path}</span>
            )}
          </div>
          <button
            type="button"
            className="ns-btn ns-btn-sm"
            data-testid="next-glab-detect"
            disabled={detecting}
            onClick={() => { void handleDetect(); }}
          >
            {detecting ? t(lang, 'glab_detecting') : t(lang, 'glab_detect')}
          </button>
        </div>

        <button
          type="button"
          className="ns-adv-toggle"
          onClick={() => setShowCustomPath((v) => !v)}
        >
          <span className={`ns-caret-tiny${showCustomPath ? ' is-open' : ''}`} />
          <span>{t(lang, 'glab_custom_toggle')}</span>
        </button>

        {showCustomPath ? (
          <div className="ns-glab-path-wrap">
            <input
              className="ns-input is-mono"
              data-testid="next-glab-path"
              value={customPath}
              placeholder={t(lang, 'glab_custom_path_placeholder')}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setCustomPath(e.target.value)}
              onBlur={() => { void handlePathBlur(); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleDetect();
              }}
            />
            <p className="ns-field-hint">{t(lang, 'glab_custom_path_hint')}</p>
          </div>
        ) : null}

        <div className="ns-pref-row">
          <div className="ns-pref-copy">
            <b>{t(lang, 'glab_enabled_label')}</b>
            <span>{t(lang, 'glab_enabled_desc')}</span>
          </div>
          <button
            type="button"
            className={`ns-switch${settings.enabled ? ' is-on' : ''}`}
            data-testid="next-glab-enabled"
            aria-pressed={settings.enabled}
            onClick={() => { void toggleEnabled(); }}
          />
        </div>

        {!ready ? (
          <div className="ns-empty">{t(lang, 'loading')}</div>
        ) : gitlabConnections.length === 0 ? (
          <div className="ns-empty-block" data-testid="next-glab-empty">
            <b>{t(lang, 'glab_empty_title')}</b>
            <p>{t(lang, 'glab_empty_body')}</p>
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                className="ns-btn ns-btn-primary"
                data-testid="next-glab-goto-git"
                onClick={handleGotoGit}
              >
                {t(lang, 'glab_goto_git')}
              </button>
            </div>
          </div>
        ) : (
          <div className={`ns-glab-connections${!settings.enabled ? ' is-disabled' : ''}`}>
            <div className="ns-section-title">
              <b>{t(lang, 'glab_connections_title')}</b>
            </div>
            <div className="ns-git-list">
              {gitlabConnections.map((conn) => {
                const checked = settings.connectionIds.includes(conn.id);
                const isDefault = settings.defaultConnectionId === conn.id;
                const statusDot = conn.lastTest?.ok
                  ? 'is-ok'
                  : conn.lastTest && conn.lastTest.ok === false
                    ? 'is-bad'
                    : '';
                return (
                  <div key={conn.id} className="ns-git-row" data-id={conn.id}>
                    <label className="ns-chk" style={{ margin: 0 }}>
                      <input
                        type="checkbox"
                        data-testid="next-glab-conn"
                        checked={checked}
                        disabled={!settings.enabled}
                        onChange={() => { void toggleConn(conn.id); }}
                      />
                    </label>
                    <div className="ns-git-main">
                      <div className="ns-git-name">
                        <span className={`ns-dot ${statusDot}`} />
                        <b>{conn.name}</b>
                        <span className="ns-tag is-key">
                          {t(lang, conn.kind === 'gitlab-com' ? 'git_kind_com' : 'git_kind_self')}
                        </span>
                      </div>
                      <div className="ns-git-meta">
                        <span className="mono">{hostLabel(conn.baseUrl)}</span>
                        {conn.lastTest?.ok ? (
                          <>
                            <span className="ns-sep">·</span>
                            <span>{conn.lastTest.username}</span>
                            <span className="ns-sep">·</span>
                            <span>{t(lang, 'git_connected')}</span>
                          </>
                        ) : conn.lastTest && conn.lastTest.ok === false ? (
                          <>
                            <span className="ns-sep">·</span>
                            <span className="ns-why">{conn.lastTest.errorText || t(lang, 'git_test')}</span>
                          </>
                        ) : (
                          <>
                            <span className="ns-sep">·</span>
                            <span>{t(lang, 'git_untested')}</span>
                          </>
                        )}
                      </div>
                    </div>
                    {checkedCount > 1 && checked ? (
                      <div className="ns-git-acts">
                        <label className="ns-glab-default-label">
                          <input
                            type="radio"
                            name="glab-default-host"
                            data-testid="next-glab-default"
                            checked={isDefault}
                            disabled={!settings.enabled}
                            onChange={() => { void selectDefault(conn.id); }}
                          />
                          <span>{t(lang, 'glab_default_host')}</span>
                        </label>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>

            <div className="ns-test-row">
              <button
                type="button"
                className="ns-btn ns-btn-sm"
                data-testid="next-glab-test"
                disabled={testing || !settings.enabled || checkedCount === 0}
                onClick={() => { void handleTest(); }}
              >
                {testing ? t(lang, 'glab_testing') : t(lang, 'glab_test')}
              </button>
              {testResult ? (
                <div
                  className={`ns-git-line ${testResult.ok ? 'is-ok' : ''}`}
                  data-testid="next-glab-test-result"
                  style={{ marginTop: 8 }}
                >
                  <span className={`ns-dot ${testResult.ok ? 'is-ok' : 'is-bad'}`} />
                  {testResult.ok ? (
                    <span>
                      {testResult.username
                        ? `${testResult.username} @ ${testResult.host}`
                        : testResult.output}
                    </span>
                  ) : (
                    <span className="ns-why">{testResult.output}</span>
                  )}
                </div>
              ) : null}
            </div>

            <p className="ns-git-foot">{t(lang, 'glab_footnote')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
