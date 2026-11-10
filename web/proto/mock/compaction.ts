import type { MockNote } from './types';

/**
 * Compaction divider note. The server writes both the short key line (shown faintly
 * next to the title) and the full summary (`detail`, shown on expand) in the client's
 * language; the client only adds the fixed title.
 */
export function compactionNote(id: string, before: number): MockNote {
  const textZh = `之前 ${before} 条已摘要`;
  const textEn = `Previous ${before} ${before === 1 ? 'item' : 'items'} summarized`;
  const detailZh = [
    '### 对话摘要',
    '',
    '- **目标**：把 store 里的订阅逻辑拆成独立模块，并补齐单测。',
    '- **已完成**：订阅逻辑已拆到 `subscribe.ts`，store 只保留数据读写。',
    '- **待办**：补充订阅取消的边界用例；检查调用方的导入路径。',
    '- **关键约定**：保持对外接口不变，不改动 `store/index.ts` 的导出。',
  ].join('\n');
  const detailEn = [
    '### Conversation summary',
    '',
    '- **Goal**: Split the subscription logic out of the store into its own module and cover it with tests.',
    '- **Done**: Subscription logic moved to `subscribe.ts`; the store keeps only data reads and writes.',
    '- **To do**: Add edge cases for unsubscribe; check import paths in callers.',
    '- **Constraint**: Keep the public interface unchanged; do not touch the exports of `store/index.ts`.',
  ].join('\n');
  return {
    kind: 'system_note',
    id,
    noteKind: 'compaction',
    text: textZh,
    i18n: { zh: textZh, en: textEn },
    detail: detailZh,
    detailI18n: { zh: detailZh, en: detailEn },
  };
}
