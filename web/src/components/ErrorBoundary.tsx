import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportClientError } from '../data/clientLog';
import { getPreferredLang } from '../data/lang';
import { t } from '../i18n';

type State = { failed: boolean };

/** Outermost boundary: report the crash, then offer a reload instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Component stack names components only; it carries no user text.
    const withStack = Object.assign(new Error(error.message), {
      stack: `${error.stack ?? ''}${info.componentStack ?? ''}`,
    });
    reportClientError(withStack, 'error-boundary');
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const lang = getPreferredLang();
    return (
      <div className="next-home" data-testid="error-boundary" role="alert">
        <h1>{t(lang, 'crash_title')}</h1>
        <button type="button" onClick={() => window.location.reload()}>
          {t(lang, 'crash_reload')}
        </button>
      </div>
    );
  }
}
