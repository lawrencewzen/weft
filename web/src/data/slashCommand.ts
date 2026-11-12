/** `/` command menu: pure helpers (trigger, filter, availability). */

export type SlashCommandId = 'compact' | 'handoff' | 'schedule' | 'model' | 'new';

/**
 * Command names of the menu. A skill with one of these ids (only possible when it already sits on
 * disk) is neither offered in the menu nor shown as a block: the backend does not call it either.
 * Keep in step with RESERVED_SKILL_IDS in src/core/skills.mjs.
 */
export const RESERVED_SKILL_IDS: readonly string[] = ['compact', 'handoff', 'schedule', 'model', 'new'];

export type SlashSkillRef = { id: string; name: string };

/** The block at the start of the input: set by `/handoff`, `/schedule` or a skill. */
export type SlashChip =
  | { kind: 'handoff' }
  | { kind: 'schedule' }
  | { kind: 'skill'; id: string; name: string };

/**
 * A sent message `/<id> body` whose id is a known skill shows as a block plus the body;
 * an unknown `/xxx` stays as typed.
 */
export function parseSkillMessage(
  text: string,
  skills: readonly { id: string; name: string }[] | null,
): { skill: SlashSkillRef; body: string } | null {
  if (!skills?.length) return null;
  const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(String(text ?? '').trim());
  if (!m) return null;
  if (RESERVED_SKILL_IDS.includes(m[1])) return null;
  const hit = skills.find((sk) => sk.id === m[1]);
  return hit ? { skill: { id: hit.id, name: hit.name }, body: (m[2] ?? '').trim() } : null;
}

export type SlashItem =
  | { kind: 'command'; id: SlashCommandId; label: string; disabled: boolean }
  | { kind: 'skill'; id: string; label: string; name: string; description: string; disabled: false };

export type SlashContext = {
  /** A real conversation exists (not a draft). */
  hasConversation: boolean;
  running: boolean;
  compacting: boolean;
  handoffRunning: boolean;
};

/**
 * The menu only opens when the whole draft is `/` plus a name: nothing but whitespace before
 * the slash, no whitespace after it, and no second slash (so `a/b` and `/usr/bin` never match).
 */
export function matchSlashTrigger(draft: string): { query: string } | null {
  const m = /^\s*\/([^\s/]*)$/.exec(draft);
  return m ? { query: m[1] } : null;
}

export function slashCommands(ctx: SlashContext): Extract<SlashItem, { kind: 'command' }>[] {
  const out: Extract<SlashItem, { kind: 'command' }>[] = [];
  if (ctx.hasConversation) {
    out.push({ kind: 'command', id: 'compact', label: '/compact', disabled: ctx.running || ctx.compacting });
    out.push({ kind: 'command', id: 'handoff', label: '/handoff', disabled: ctx.running || ctx.handoffRunning });
  }
  out.push({ kind: 'command', id: 'schedule', label: '/schedule', disabled: false });
  out.push({ kind: 'command', id: 'model', label: '/model', disabled: false });
  out.push({ kind: 'command', id: 'new', label: '/new', disabled: false });
  return out;
}

type SkillLike = { id: string; name: string; description: string; enabled?: boolean };

export function slashSkillItems(skills: readonly SkillLike[]): Extract<SlashItem, { kind: 'skill' }>[] {
  return skills
    .filter((s) => s.enabled !== false && !RESERVED_SKILL_IDS.includes(s.id))
    .map((s) => ({
      kind: 'skill' as const,
      id: s.id,
      label: `/${s.id}`,
      name: s.name,
      description: s.description,
      disabled: false as const,
    }));
}

/**
 * Prefix match on the command or skill id ranks first, then contains-match on the id or the
 * skill's display name. Commands stay ahead of skills within each rank.
 */
export function filterSlashItems(items: readonly SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice();
  const prefix: SlashItem[] = [];
  const contains: SlashItem[] = [];
  for (const item of items) {
    const id = item.id.toLowerCase();
    const name = item.kind === 'skill' ? item.name.toLowerCase() : '';
    if (id.startsWith(q)) prefix.push(item);
    else if (id.includes(q) || (name && name.includes(q))) contains.push(item);
  }
  return [...prefix, ...contains];
}

export function stepSlashIndex(index: number, length: number, dir: 'up' | 'down'): number {
  if (length <= 0) return 0;
  return dir === 'down' ? (index + 1) % length : (index - 1 + length) % length;
}

/** Message text sent for a chosen skill: `/<id> <body>`. */
export function composeSkillMessage(skill: SlashSkillRef | null, body: string): string {
  const text = body.trim();
  if (!skill) return text;
  return text ? `/${skill.id} ${text}` : `/${skill.id}`;
}
