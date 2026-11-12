// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserMessage } from './UserMessage';
import { SessionContext, type SessionValue } from '../data/session';
import { RightPaneProvider } from '../data/rightPaneContext';
import { createEntityStore } from '../data/store';
import { resetSkillCatalog } from '../data/skillCatalog';
import { listSkills } from '../data/api';
import type { components } from '../../../src/v2/contract.gen';

vi.mock('../data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/api')>();
  return { ...actual, listSkills: vi.fn() };
});

type ThreadItemUser = components['schemas']['ThreadItemUser'];

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function renderUser(text: string) {
  const item: ThreadItemUser = { kind: 'user', id: 'u-1', entryId: 'e-1', text, pathRefs: [] };
  const value: SessionValue = {
    store: createEntityStore(),
    status: 'connected',
    conversationId: 'c1',
    lang: 'zh',
    extraConversationIds: [],
    setExtraConversationIds: vi.fn(),
    retainTopic: vi.fn(),
    releaseTopic: vi.fn(),
    topics: [],
  };
  await act(async () => {
    root!.render(
      <SessionContext.Provider value={value}>
        <RightPaneProvider conversationId="c1" workspaceId={null} lang="zh" onToast={vi.fn()}>
          <UserMessage item={item} lang="zh" />
        </RightPaneProvider>
      </SessionContext.Provider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('UserMessage skill block', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetSkillCatalog();
    vi.mocked(listSkills).mockReset();
    vi.mocked(listSkills).mockResolvedValue({
      skills: [{ id: 'code-review', name: '代码审查', description: '', version: '1', source: 'x', enabled: true, deletable: false }],
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root!.unmount(); });
    host!.remove();
  });

  it('shows the skill name as a block and the body without the /id prefix', async () => {
    await renderUser('/code-review 看一下这次改动');
    expect(host!.querySelector('[data-testid="next-user-chip"]')?.textContent).toBe('代码审查');
    const body = host!.querySelector('[data-testid="next-markdown"]')!;
    expect(body.textContent).toContain('看一下这次改动');
    expect(body.textContent).not.toContain('/code-review');
  });

  it('shows an unknown /xxx as typed', async () => {
    await renderUser('/nope 看一下');
    expect(host!.querySelector('[data-testid="next-user-chip"]')).toBeNull();
    expect(host!.querySelector('[data-testid="next-markdown"]')!.textContent).toContain('/nope 看一下');
  });

  it('does not ask for skills on plain messages', async () => {
    await renderUser('普通消息');
    expect(listSkills).not.toHaveBeenCalled();
    expect(host!.querySelector('[data-testid="next-user-chip"]')).toBeNull();
  });
});
