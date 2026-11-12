import { describe, expect, it } from 'vitest';
import {
  composeSkillMessage,
  filterSlashItems,
  matchSlashTrigger,
  RESERVED_SKILL_IDS,
  parseSkillMessage,
  slashCommands,
  slashSkillItems,
  stepSlashIndex,
  type SlashContext,
} from './slashCommand';

const idle: SlashContext = { hasConversation: true, running: false, compacting: false, handoffRunning: false };

describe('matchSlashTrigger', () => {
  it('opens when the slash is first, with optional leading whitespace', () => {
    expect(matchSlashTrigger('/')).toEqual({ query: '' });
    expect(matchSlashTrigger('/com')).toEqual({ query: 'com' });
    expect(matchSlashTrigger('  /new')).toEqual({ query: 'new' });
  });

  it('does not open for a slash in the middle', () => {
    expect(matchSlashTrigger('hello /compact')).toBeNull();
    expect(matchSlashTrigger('hello\n/compact')).toBeNull();
  });

  it('does not open for paths', () => {
    expect(matchSlashTrigger('a/b')).toBeNull();
    expect(matchSlashTrigger('/usr/bin')).toBeNull();
    expect(matchSlashTrigger('src/')).toBeNull();
  });

  it('closes once whitespace follows the name', () => {
    expect(matchSlashTrigger('/handoff ')).toBeNull();
    expect(matchSlashTrigger('/handoff 重点')).toBeNull();
    expect(matchSlashTrigger('')).toBeNull();
  });
});

describe('slashCommands availability', () => {
  it('hides compact and handoff in a draft', () => {
    const ids = slashCommands({ ...idle, hasConversation: false }).map((c) => c.id);
    expect(ids).toEqual(['schedule', 'new']);
  });

  it('disables compact and handoff while running', () => {
    const cmds = slashCommands({ ...idle, running: true });
    expect(cmds.find((c) => c.id === 'compact')?.disabled).toBe(true);
    expect(cmds.find((c) => c.id === 'handoff')?.disabled).toBe(true);
  });

  it('disables only the busy one when compacting or handing off', () => {
    const compacting = slashCommands({ ...idle, compacting: true });
    expect(compacting.find((c) => c.id === 'compact')?.disabled).toBe(true);
    expect(compacting.find((c) => c.id === 'handoff')?.disabled).toBe(false);
    const handing = slashCommands({ ...idle, handoffRunning: true });
    expect(handing.find((c) => c.id === 'compact')?.disabled).toBe(false);
    expect(handing.find((c) => c.id === 'handoff')?.disabled).toBe(true);
  });

  it('enables everything when idle', () => {
    expect(slashCommands(idle).every((c) => !c.disabled)).toBe(true);
  });
});

describe('filterSlashItems', () => {
  const items = [
    ...slashCommands(idle),
    ...slashSkillItems([
      { id: 'code-review', name: '代码审查', description: '', enabled: true },
      { id: 'compact-notes', name: '纪要', description: '', enabled: true },
      { id: 'off', name: '停用', description: '', enabled: false },
    ]),
  ];

  it('returns everything for an empty query, skipping disabled skills', () => {
    const all = filterSlashItems(items, '');
    expect(all.map((i) => i.id)).toEqual([
      'compact', 'handoff', 'schedule', 'new', 'code-review', 'compact-notes',
    ]);
  });

  it('ranks prefix matches first, commands before skills', () => {
    expect(filterSlashItems(items, 'co').map((i) => i.id)).toEqual(['compact', 'code-review', 'compact-notes']);
  });

  it('matches by contains on id and by skill name', () => {
    expect(filterSlashItems(items, 'review').map((i) => i.id)).toEqual(['code-review']);
    expect(filterSlashItems(items, '审查').map((i) => i.id)).toEqual(['code-review']);
    expect(filterSlashItems(items, 'zzz')).toEqual([]);
  });

  it('is case-insensitive', () => {
    expect(filterSlashItems(items, 'SCH').map((i) => i.id)).toEqual(['schedule']);
  });
});

describe('stepSlashIndex', () => {
  it('wraps both ways', () => {
    expect(stepSlashIndex(0, 3, 'up')).toBe(2);
    expect(stepSlashIndex(2, 3, 'down')).toBe(0);
    expect(stepSlashIndex(0, 0, 'down')).toBe(0);
  });
});

describe('reserved skill ids', () => {
  it('matches the command names and keeps a same-named skill off the menu and out of bubbles', () => {
    expect([...RESERVED_SKILL_IDS].sort()).toEqual(
      slashCommands({ ...idle }).map((c) => c.id).sort(),
    );
    const skills = [
      { id: 'compact', name: '压缩', description: '', enabled: true },
      { id: 'code-review', name: '代码审查', description: '', enabled: true },
    ];
    expect(slashSkillItems(skills).map((i) => i.id)).toEqual(['code-review']);
    expect(parseSkillMessage('/compact 看一下', skills)).toBeNull();
    expect(parseSkillMessage('/code-review 看一下', skills)?.skill.id).toBe('code-review');
  });
});

describe('composeSkillMessage / parseSkillMessage', () => {
  const skills = [{ id: 'code-review', name: '代码审查' }];

  it('prefixes the skill id', () => {
    expect(composeSkillMessage({ id: 'code-review', name: '代码审查' }, ' 看一下 ')).toBe('/code-review 看一下');
    expect(composeSkillMessage({ id: 'code-review', name: '代码审查' }, '')).toBe('/code-review');
    expect(composeSkillMessage(null, ' hi ')).toBe('hi');
  });

  it('parses a known skill prefix', () => {
    expect(parseSkillMessage('/code-review 看一下\n第二行', skills)).toEqual({
      skill: { id: 'code-review', name: '代码审查' },
      body: '看一下\n第二行',
    });
    expect(parseSkillMessage('/code-review', skills)?.body).toBe('');
  });

  it('leaves unknown ids, paths and plain text alone', () => {
    expect(parseSkillMessage('/nope 看一下', skills)).toBeNull();
    expect(parseSkillMessage('/code-review2 x', skills)).toBeNull();
    expect(parseSkillMessage('/usr/bin x', skills)).toBeNull();
    expect(parseSkillMessage('hi /code-review', skills)).toBeNull();
    expect(parseSkillMessage('/code-review x', null)).toBeNull();
    expect(parseSkillMessage('/code-review x', [])).toBeNull();
  });
});
