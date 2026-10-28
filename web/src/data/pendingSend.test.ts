import { describe, expect, it } from 'vitest';
import {
  countUserText,
  hydratePendingFromSends,
  pendingItem,
  queueChips,
  settlePending,
  threadPending,
  waitingForAgent,
  PENDING_TIMEOUT_MS,
  type PendingUser,
} from './pendingSend';
import type { ThreadItem } from './store';

function user(id: string, text: string): ThreadItem {
  return { kind: 'user', id, text, pathRefs: [] };
}

function report(id: string, name: string, body: string): ThreadItem {
  return {
    kind: 'subagent_report',
    id,
    subagentId: null,
    name,
    reportKind: 'answered',
    body,
  };
}

function assistant(id: string, text: string): ThreadItem {
  return { kind: 'assistant', id, text, pathRefs: [], streaming: false, truncated: false };
}

const sent: PendingUser = { key: 'r1', text: '改一下圆角', baseline: 0, doneAt: 1000 };

describe('pendingItem images', () => {
  it('copies images onto the optimistic user bubble as metadata with a local url', () => {
    const images = [{ mediaType: 'image/png' as const, data: 'AAAA', name: 'shot.png' }];
    expect(pendingItem({ key: 'r1', text: '', images, baseline: 0, doneAt: null })).toMatchObject({
      kind: 'user',
      id: 'local:r1',
      text: '',
      images: [{
        index: 0,
        mediaType: 'image/png',
        name: 'shot.png',
        bytes: 3,
        url: 'data:image/png;base64,AAAA',
      }],
    });
  });
});

describe('countUserText', () => {
  it('counts only user items with the same trimmed text', () => {
    const items = [user('1', '改一下圆角'), user('2', ' 改一下圆角 '), assistant('3', '改一下圆角')];
    expect(countUserText(items, '改一下圆角')).toBe(2);
    expect(countUserText(items, '别的话')).toBe(0);
    expect(countUserText(items, '   ')).toBe(0);
  });
});

describe('settlePending by requestId', () => {
  it('keeps the pending send until the server names its entry', () => {
    expect(settlePending([sent], [], { now: 1000 })).toEqual([sent]);
    expect(settlePending([sent], [assistant('9', '好的')], { now: 1000 })).toEqual([sent]);
  });

  it('drops the pending send once the named entry is in the thread', () => {
    const sends = [{ requestId: 'r1', entryId: '12', dropped: false }];
    expect(settlePending([sent], [user('12', '改一下圆角')], { sends, now: 1000 })).toEqual([]);
  });

  it('ignores an entry id that belongs to another send', () => {
    const sends = [{ requestId: 'others', entryId: '12', dropped: false }];
    expect(settlePending([sent], [user('12', '别的话')], { sends, now: 1000 })).toEqual([sent]);
  });

  it('collects a send the server rendered as a subagent-report card', () => {
    const entry = `[subagent 巡查 answered, no reply needed] 仓库干净`;
    const card: PendingUser = { key: 'r9', text: entry, baseline: 0, doneAt: 1000 };
    const sends = [{ requestId: 'r9', entryId: '40', dropped: false }];
    const items = [user('1', '请派子代理'), report('40', '巡查', '仓库干净')];
    expect(settlePending([card], items, { sends, now: 1000 })).toEqual([]);
  });

  it('collects a send the server reports only after the run ended, not just the newest one', () => {
    // 连发两条：服务端把两条都报回来，第一条（卡片）也照常收回。
    const first: PendingUser = { key: 'a', text: '[subagent 巡查 answered] 一', baseline: 0, doneAt: 1000 };
    const second: PendingUser = { key: 'b', text: '[subagent 编码 failed: x]', baseline: 0, doneAt: 1000 };
    const sends = [
      { requestId: 'a', entryId: '13', dropped: false },
      { requestId: 'b', entryId: '17', dropped: false },
    ];
    const items = [user('8', '请派子代理'), report('13', '巡查', '一')];
    expect(settlePending([first, second], items, { sends, now: 1000 })).toEqual([second]);
  });

  it('keeps a queued send on screen however long the queue takes', () => {
    // 运行中插话要等工具批次结束才落盘：期间服务端报 entryId null / dropped false。
    const queued = [{ requestId: 'r1', entryId: null, dropped: false }];
    expect(settlePending([sent], [assistant('2', '好的')], { sends: queued, now: 1000 })).toEqual([sent]);
    expect(settlePending([sent], [assistant('2', '还在跑')], { sends: queued, now: 1000 + PENDING_TIMEOUT_MS - 1 })).toEqual([sent]);
    // 超过 10 秒上限也不收回。
    expect(settlePending([sent], [assistant('2', '还在跑')], { sends: queued, now: 1000 + PENDING_TIMEOUT_MS * 6 })).toEqual([sent]);
  });

  it('collects a queued send once it lands in the thread', () => {
    const queued = [{ requestId: 'r1', entryId: null, dropped: false }];
    const items = [assistant('2', '跑完了'), user('3', '改一下圆角')];
    expect(settlePending([sent], items, { sends: queued, now: 1000 })).toEqual([sent]);
    const placed = [{ requestId: 'r1', entryId: '3', dropped: false }];
    expect(settlePending([sent], items, { sends: placed, now: 1000 })).toEqual([]);
  });

  it('drops a send the server reports as withdrawn before it landed', () => {
    const withdrawn = [{ requestId: 'r1', entryId: null, dropped: true }];
    expect(settlePending([sent], [assistant('2', '跑完了')], { sends: withdrawn, now: 1000 })).toEqual([]);
  });
});

describe('settlePending by text and timeout', () => {
  it('drops the pending send once the confirmed item shows up', () => {
    expect(settlePending([sent], [user('1', '改一下圆角')], { now: 1000 })).toEqual([]);
  });

  it('does not let an older identical message clear a new send', () => {
    const items = [user('1', '改一下圆角')];
    const second: PendingUser = {
      key: 'r2',
      text: '改一下圆角',
      baseline: countUserText(items, '改一下圆角'),
      doneAt: 1000,
    };
    expect(settlePending([second], [...items, assistant('2', '好')], { now: 1000 })).toEqual([second]);
    expect(settlePending([second], [...items, user('3', '改一下圆角')], { now: 1000 })).toEqual([]);
  });

  it('clears two identical sends one by one as their items arrive', () => {
    const items = [user('1', '改一下圆角')];
    const a: PendingUser = { key: 'a', text: '改一下圆角', baseline: 1, doneAt: 1000 };
    const b: PendingUser = { key: 'b', text: '改一下圆角', baseline: 1, doneAt: 1000 };
    expect(settlePending([a, b], items, { now: 1000 })).toEqual([a, b]);
    expect(settlePending([a, b], [...items, user('2', '改一下圆角')], { now: 1000 })).toEqual([b]);
    expect(settlePending([a, b], [...items, user('2', '改一下圆角'), user('3', '改一下圆角')], { now: 1000 })).toEqual([]);
  });

  it('pairs two sends of the same text by requestId', () => {
    // 两条同文：服务端报告的 entry 是第一条的，第二条还要等自己的条目。
    const a: PendingUser = { key: 'a', text: '继续', baseline: 0, doneAt: 1000 };
    const b: PendingUser = { key: 'b', text: '继续', baseline: 0, doneAt: 1000 };
    const afterFirst = [user('52', '继续')];
    const sendsA = [{ requestId: 'a', entryId: '52', dropped: false }];
    expect(settlePending([a, b], afterFirst, { sends: sendsA, now: 1000 })).toEqual([b]);
    const sendsB = [{ requestId: 'b', entryId: '53', dropped: false }];
    expect(settlePending([b], [...afterFirst, user('53', '继续')], { sends: sendsB, now: 1000 })).toEqual([]);
  });

  it('drops a resolved send after the cap when the server does not report it at all', () => {
    // 服务重启、或超出 sends 的 20 条 / 5 分钟窗口：没有 requestId 可对，只能靠文本和上限。
    expect(settlePending([sent], [], { sends: [], now: 1000 + PENDING_TIMEOUT_MS - 1 })).toEqual([sent]);
    expect(settlePending([sent], [], { sends: [], now: 1000 + PENDING_TIMEOUT_MS })).toEqual([]);
    const other = [{ requestId: 'someone-else', entryId: null, dropped: false }];
    expect(settlePending([sent], [], { sends: other, now: 1000 + PENDING_TIMEOUT_MS - 1 })).toEqual([sent]);
    expect(settlePending([sent], [], { sends: other, now: 1000 + PENDING_TIMEOUT_MS })).toEqual([]);
  });

  it('never drops a send whose POST has not resolved yet', () => {
    const inFlight: PendingUser = { key: 'r1', text: '改一下圆角', baseline: 0, doneAt: null };
    expect(settlePending([inFlight], [], { now: 10 * PENDING_TIMEOUT_MS })).toEqual([inFlight]);
  });
});

describe('pendingItem', () => {
  it('renders as a normal user message with a local id', () => {
    expect(pendingItem(sent)).toMatchObject({ kind: 'user', id: 'local:r1', text: '改一下圆角' });
  });
});

describe('queue vs steer pending', () => {
  it('keeps queue chips out of the thread and lists them separately', () => {
    const queued: PendingUser = { key: 'q1', text: '稍后改主题', baseline: 0, doneAt: 1000, mode: 'queue' };
    const steered: PendingUser = { key: 's1', text: '插一句', baseline: 0, doneAt: 1000, mode: 'steer' };
    const sends = [
      { requestId: 'q1', entryId: null, dropped: false, mode: 'queue' as const, text: '稍后改主题' },
      { requestId: 's1', entryId: null, dropped: false, mode: 'steer' as const, text: '插一句' },
    ];
    const kept = settlePending([queued, steered], [], { sends, now: 1000 });
    expect(threadPending(kept).map((row) => row.key)).toEqual(['s1']);
    expect(queueChips(kept, sends)).toEqual([{ requestId: 'q1', text: '稍后改主题' }]);
    expect(pendingItem(steered)).toMatchObject({ steered: true, id: 'local:s1' });
  });

  it('rebuilds inbox rows from sends after a refresh', () => {
    const sends = [
      { requestId: 'q1', entryId: null, dropped: false, mode: 'queue' as const, text: '排队文字' },
      { requestId: 's1', entryId: null, dropped: false, mode: 'steer' as const, text: '已插话' },
    ];
    const hydrated = hydratePendingFromSends([], sends);
    expect(threadPending(hydrated).map((row) => row.text)).toEqual(['已插话']);
    expect(queueChips(hydrated, sends)).toEqual([{ requestId: 'q1', text: '排队文字' }]);
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
