// Plugs the full Windows self-check (win/doctor.mjs) into the problem report's doctor.txt.
// The section is bounded by a timeout so a hung pwsh probe never blocks the export.
import { registerDoctor } from '../../core/doctor.mjs';
import { runDoctor as runWinDoctor, reportContainsSecrets } from './doctor.mjs';

export const WIN_DOCTOR_TIMEOUT_MS = 15000;
export const WIN_DOCTOR_TIMEOUT_TEXT = '超时';

export function createWinDoctorSection({ run = runWinDoctor, timeoutMs = WIN_DOCTOR_TIMEOUT_MS, env = process.env } = {}) {
  return async (ctx = {}) => {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(WIN_DOCTOR_TIMEOUT_TEXT), timeoutMs);
      timer.unref?.();
    });
    try {
      const text = await Promise.race([Promise.resolve().then(() => run({ dataDir: ctx.dataDir || '' })), timeout]);
      const str = String(text ?? '');
      // Belt and braces: the check only reports whether a variable is set, never its value.
      return reportContainsSecrets(str, env).length ? '（输出含疑似密钥，已省略）' : str;
    } finally {
      clearTimeout(timer);
    }
  };
}

export function registerWinDoctor({ platform = process.platform, ...opts } = {}) {
  if (platform !== 'win32') return null;
  return registerDoctor('windows', createWinDoctorSection(opts));
}
