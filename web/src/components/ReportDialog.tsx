import { useEffect, useMemo, useRef, useState } from 'react';
import { createDiagnosticsReport } from '../data/api';
import { hasDesktopShell, shellRevealInFolder, shellSaveReport } from '../data/desktopShell';
import type { Lang } from '../data/lang';
import {
  REPORT_PATH,
  closeReportDialog,
  reportFileList,
  reportFileName,
  type ReportDialogOpen,
  type ReportRequest,
} from '../data/reportDialog';
import { t } from '../i18n';

type Status =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'done'; path?: string }
  | { kind: 'error'; message: string };

function triggerDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function ReportDialog({ lang, open }: { lang: Lang; open: ReportDialogOpen }) {
  const { conversationId } = open;
  const [description, setDescription] = useState('');
  const [includeLogs, setIncludeLogs] = useState(true);
  const [includeDoctor, setIncludeDoctor] = useState(true);
  const [includeConversation, setIncludeConversation] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const area = useRef<HTMLTextAreaElement | null>(null);
  const busy = status.kind === 'busy';

  useEffect(() => { area.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && !busy) closeReportDialog();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy]);

  const request: ReportRequest = useMemo(() => ({
    description: description.trim(),
    includeLogs,
    includeDoctor,
    ...(conversationId && includeConversation ? { conversationId } : {}),
  }), [conversationId, description, includeConversation, includeDoctor, includeLogs]);
  const files = useMemo(() => reportFileList(request), [request]);
  const shell = hasDesktopShell();

  const doExport = async () => {
    setStatus({ kind: 'busy' });
    const name = reportFileName();
    try {
      if (shell) {
        const res = await shellSaveReport({ suggestedName: name, url: REPORT_PATH, body: request });
        if (res.canceled) setStatus({ kind: 'idle' });
        else if (res.ok) setStatus({ kind: 'done', path: res.path });
        else setStatus({ kind: 'error', message: res.error || '' });
      } else {
        triggerDownload(await createDiagnosticsReport(request), name);
        setStatus({ kind: 'done' });
      }
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : '' });
    }
  };

  return (
    <div
      className="modal-overlay"
      data-testid="next-report-overlay"
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget && !busy) closeReportDialog();
      }}
    >
      <div className="modal-dialog report-dialog" role="dialog" aria-modal="true" data-testid="next-report">
        <h3>
          {t(lang, 'report_title')}
          <button
            type="button"
            className="confirm-close"
            aria-label={t(lang, 'btn_cancel')}
            disabled={busy}
            onClick={() => closeReportDialog()}
          >
            ×
          </button>
        </h3>
        <label className="report-field">
          <span>{t(lang, 'report_what_happened')}</span>
          <textarea
            ref={area}
            className="ns-textarea report-text"
            data-testid="next-report-text"
            rows={4}
            maxLength={20000}
            placeholder={t(lang, 'report_what_placeholder')}
            value={description}
            disabled={busy}
            onChange={(ev) => setDescription(ev.target.value)}
          />
        </label>
        <div className="report-checks">
          <label>
            <input
              type="checkbox"
              data-testid="next-report-logs"
              checked={includeLogs}
              disabled={busy}
              onChange={(ev) => setIncludeLogs(ev.target.checked)}
            />
            {t(lang, 'report_include_logs')}
          </label>
          <label>
            <input
              type="checkbox"
              data-testid="next-report-doctor"
              checked={includeDoctor}
              disabled={busy}
              onChange={(ev) => setIncludeDoctor(ev.target.checked)}
            />
            {t(lang, 'report_include_doctor')}
          </label>
          {conversationId ? (
            <label>
              <input
                type="checkbox"
                data-testid="next-report-conversation"
                checked={includeConversation}
                disabled={busy}
                onChange={(ev) => setIncludeConversation(ev.target.checked)}
              />
              {t(lang, 'report_include_conversation')}
            </label>
          ) : null}
        </div>
        <div className="report-files">
          <div className="report-files-title">{t(lang, 'report_files')}</div>
          <ul data-testid="next-report-files">
            {files.map((name) => <li key={name}>{name}</li>)}
          </ul>
        </div>
        <div className="report-foot">
          <div className="report-status" data-testid="next-report-status" role="status">
            {status.kind === 'busy' ? t(lang, 'report_exporting') : null}
            {status.kind === 'done' ? (
              <>
                <span className="report-ok">{t(lang, 'report_exported')}</span>
                {status.path ? (
                  <button
                    type="button"
                    className="report-link"
                    data-testid="next-report-reveal"
                    onClick={() => shellRevealInFolder(status.path!)}
                  >
                    {t(lang, 'report_reveal')}
                  </button>
                ) : null}
              </>
            ) : null}
            {status.kind === 'error' ? (
              <span className="report-err">{t(lang, 'report_failed', { error: status.message })}</span>
            ) : null}
          </div>
          <div className="modal-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => closeReportDialog()}>
              {t(lang, 'btn_cancel')}
            </button>
            <button type="button" className="btn p" data-testid="next-report-export" disabled={busy} onClick={() => { void doExport(); }}>
              {busy ? t(lang, 'report_exporting') : t(lang, 'report_export')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
