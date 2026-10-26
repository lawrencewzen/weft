import { describe, expect, it } from 'vitest';
import {
  countUserText,
  pendingItem,
  settlePending,
  waitingForAgent,
  type PendingUser,
} from './pendingSend';
import type { ThreadItem } from './store';

function user(id: string, text: string): ThreadItem {
  return { kind: 'user', id, text, pathRefs: [] } as ThreadItem;
}

function assistant(id: string, text: string): ThreadItem {
  const item: ThreadItem = { kind: 'assistant', id, text, pathRefs: [], streaming: false, truncated: false };
  return item;
}

const sent: PendingUser = { key: 'r1', text: '改一下圆角', baseline: 0 };

describe('countUserText', () => {
  it('counts only user items with the same trimmed text', () => {
    const items = [user('1', '改一下圆角'), user('2', ' 改一下圆角 '), assistant('3', '改一下圆角')];
    expect(countUserText(items, '改一下圆角')).toBe(2);
    expect(countUserText(items, '别的话')).toBe(0);
    expect(countUserText(items, '   ')).toBe(0);
  });
});

describe('settlePending', () => {
  it('keeps the pending send until the server thread has the message', () => {
    expect(settlePending([sent], [])).toEqual([sent]);
    expect(settlePending([sent], [assistant('9', '好的')])).toEqual([sent]);
  });

  it('drops the pending send once the confirmed item shows up', () => {
    expect(settlePending([sent], [user('1', '改一下圆角')])).toEqual([]);
  });

  it('does not let an older identical message clear a new send', () => {
    const items = [user('1', '改一下圆角')];
    const second: PendingUser = { key: 'r2', text: '改一下圆角', baseline: countUserText(items, '改一下圆角') };
    expect(settlePending([second], [...items, assistant('2', '好')])).toEqual([second]);
    expect(settlePending([second], [...items, user('3', '改一下圆角')])).toEqual([]);
  });

  it('clears two identical sends once both are confirmed', () => {
    const items = [user('1', '改一下圆角')];
    const a: PendingUser = { key: 'a', text: '改一下圆角', baseline: 1 };
    const b: PendingUser = { key: 'b', text: '改一下圆角', baseline: 1 };
    expect(settlePending([a, b], items)).toEqual([a, b]);
    expect(settlePending([a, b], [...items, user('2', '改一下圆角')])).toEqual([]);
  });
});

describe('pendingItem', () => {
  it('renders as a normal user message with a local id', () => {
    expect(pendingItem(sent)).toMatchObject({ kind: 'user', id: 'local:r1', text: '改一下圆角' });
  });
});

describe('waitingForAgent', () => {
  it('is on while a send is unconfirmed, even before the run starts', () => {
    expect(waitingForAgent([], { running: false, pending: true })).toBe(true);
  });

  it('is on while the run is going and the last item is the user message', () => {
    expect(waitingForAgent([user('1', '你好')], { running: true, pending: false })).toBe(true);
    expect(waitingForAgent([], { running: true, pending: false })).toBe(true);
  });

  it('is off once the agent shows text, a tool group, or the run stops', () => {
    expect(waitingForAgent([user('1', '你好'), assistant('2', '开始')], { running: true, pending: false })).toBe(false);
    expect(waitingForAgent([user('1', '你好')], { running: false, pending: false })).toBe(false);
  });
});
