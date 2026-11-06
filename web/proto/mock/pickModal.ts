import type { Lang } from './types';
import type { MockReply } from './http';

export function isBlockedPath(p: string): boolean {
  const norm = p.replaceAll('/', '\\').toLowerCase();
  return (
    norm.includes('\\.ssh')
    || norm === '~\\.ssh'
    || norm.endsWith('\\.ssh')
    || norm === '.ssh'
    || norm === '~/.ssh'
  );
}

export function showProtoPickModal(lang: Lang): Promise<MockReply> {
  if (typeof document === 'undefined') {
    return Promise.resolve({
      status: 200,
      body: { status: 'unsupported' },
      headers: {},
    });
  }

  return new Promise<MockReply>((resolve) => {
    const existing = document.querySelector('.proto-pick-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'proto-pick-overlay';
    overlay.dataset.testid = 'proto-pick-modal';
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483646',
      background: 'rgba(0, 0, 0, 0.45)',
      backdropFilter: 'blur(2px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px',
    });

    const dialog = document.createElement('div');
    dialog.className = 'proto-pick-dialog';
    Object.assign(dialog.style, {
      background: 'var(--panel, #ffffff)',
      color: 'var(--ink, #1f2328)',
      borderRadius: '12px',
      boxShadow: '0 16px 36px rgba(0, 0, 0, 0.22), 0 0 0 1px var(--bd2, rgba(0,0,0,0.12))',
      width: '100%',
      maxWidth: '460px',
      padding: '20px 24px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      display: 'flex',
      flexDirection: 'column',
      gap: '14px',
    });

    const title = document.createElement('h3');
    title.textContent = '系统选文件夹窗口（原型模拟）';
    Object.assign(title.style, {
      margin: '0',
      fontSize: '16px',
      fontWeight: '600',
    });

    const hint = document.createElement('p');
    hint.textContent = lang === 'en'
      ? 'Simulated system folder picker. Choose a folder, simulate unsupported fallback, or cancel.'
      : '模拟操作系统原生选文件夹窗口。可直接选择文件夹、测试不支持后备、或取消。';
    Object.assign(hint.style, {
      margin: '0',
      fontSize: '13px',
      color: 'var(--mute, #656d76)',
      lineHeight: '1.4',
    });

    const inputWrap = document.createElement('div');
    Object.assign(inputWrap.style, {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
    });

    const inputLabel = document.createElement('label');
    inputLabel.textContent = lang === 'en' ? 'Selected folder path:' : '所选文件夹路径：';
    Object.assign(inputLabel.style, {
      fontSize: '12px',
      fontWeight: '500',
      color: 'var(--mute, #656d76)',
    });

    const input = document.createElement('input');
    input.type = 'text';
    input.value = 'D:\\work\\sandbox\\playground';
    input.dataset.testid = 'proto-pick-path';
    Object.assign(input.style, {
      width: '100%',
      boxSizing: 'border-box',
      padding: '7px 10px',
      borderRadius: '6px',
      border: '1px solid var(--bd2, #d0d7de)',
      background: 'var(--bg, #f6f8fa)',
      color: 'inherit',
      fontSize: '13px',
      fontFamily: 'monospace',
    });

    inputWrap.appendChild(inputLabel);
    inputWrap.appendChild(input);

    const quickRow = document.createElement('div');
    Object.assign(quickRow.style, {
      display: 'flex',
      gap: '8px',
      flexWrap: 'wrap',
    });

    const quickBlocked = document.createElement('button');
    quickBlocked.type = 'button';
    quickBlocked.textContent = lang === 'en' ? 'Simulate blocked (~/.ssh)' : '模拟被拦截路径 (~/.ssh)';
    quickBlocked.dataset.testid = 'proto-pick-blocked';
    Object.assign(quickBlocked.style, {
      padding: '4px 8px',
      fontSize: '11px',
      border: '1px dashed var(--fail, #cf222e)',
      borderRadius: '4px',
      background: 'transparent',
      color: 'var(--fail, #cf222e)',
      cursor: 'pointer',
    });
    quickBlocked.addEventListener('click', () => {
      input.value = '~/.ssh';
    });
    quickRow.appendChild(quickBlocked);

    const btnRow = document.createElement('div');
    Object.assign(btnRow.style, {
      display: 'flex',
      justifyContent: 'flex-end',
      gap: '8px',
      marginTop: '8px',
    });

    function finish(reply: MockReply) {
      overlay.remove();
      resolve(reply);
    }

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = lang === 'en' ? 'Cancel' : '取消';
    cancelBtn.dataset.testid = 'proto-pick-cancel';
    Object.assign(cancelBtn.style, {
      padding: '6px 12px',
      borderRadius: '6px',
      border: '1px solid var(--bd2, #d0d7de)',
      background: 'transparent',
      color: 'inherit',
      fontSize: '13px',
      cursor: 'pointer',
    });
    cancelBtn.addEventListener('click', () => {
      finish({ status: 200, body: { status: 'cancelled' }, headers: {} });
    });

    const unsuppBtn = document.createElement('button');
    unsuppBtn.type = 'button';
    unsuppBtn.textContent = lang === 'en' ? 'Unsupported' : '不支持';
    unsuppBtn.dataset.testid = 'proto-pick-unsupported';
    Object.assign(unsuppBtn.style, {
      padding: '6px 12px',
      borderRadius: '6px',
      border: '1px solid var(--bd2, #d0d7de)',
      background: 'transparent',
      color: 'inherit',
      fontSize: '13px',
      cursor: 'pointer',
    });
    unsuppBtn.addEventListener('click', () => {
      finish({ status: 200, body: { status: 'unsupported' }, headers: {} });
    });

    const pickBtn = document.createElement('button');
    pickBtn.type = 'button';
    pickBtn.textContent = lang === 'en' ? 'Select folder' : '选择某个文件夹';
    pickBtn.dataset.testid = 'proto-pick-folder';
    Object.assign(pickBtn.style, {
      padding: '6px 14px',
      borderRadius: '6px',
      border: '0',
      background: 'var(--accent, #0969da)',
      color: '#ffffff',
      fontSize: '13px',
      fontWeight: '500',
      cursor: 'pointer',
    });
    pickBtn.addEventListener('click', () => {
      const chosen = input.value.trim() || 'D:\\work\\sandbox\\playground';
      if (isBlockedPath(chosen)) {
        finish({
          status: 400,
          body: { error: lang === 'en' ? 'Path is not allowed' : '目录不允许访问', code: 'E_PATH' },
          headers: {},
        });
      } else {
        finish({ status: 200, body: { status: 'picked', path: chosen }, headers: {} });
      }
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(unsuppBtn);
    btnRow.appendChild(pickBtn);

    dialog.appendChild(title);
    dialog.appendChild(hint);
    dialog.appendChild(inputWrap);
    dialog.appendChild(quickRow);
    dialog.appendChild(btnRow);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  });
}
