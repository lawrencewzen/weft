// The main agent's `schedule` tool. Children never receive it (CHILD_HIDDEN_TOOLS).
// It only calls the schedule service; the Durable task does the waiting and sending.
import { arr, bool, int, lit, nullable, obj, opt, str, union } from '@earendil-works/pi-schema';
import { defineTool } from '@earendil-works/pi-durable';
import { MIN_INTERVAL_MINUTES } from '../core/schedule-time.mjs';

export const SCHEDULE_TOOL_NAME = 'schedule';

export const SCHEDULE_TOOL_DESCRIPTION = [
  'Manage the user\'s scheduled tasks: messages Weft sends on its own at set times.',
  'action is one of list, create, update, pause, resume, delete. create needs name, message and rule; update, pause, resume and delete need id (see list).',
  'message is what gets sent, so write it as the user would, with everything needed to act on it later.',
  'target says where it is sent. Omit it to use this conversation. {kind:"conversation", conversationId} sends to an existing conversation; {kind:"new", workspaceId, model?} opens a new conversation in that workspace every time (model omitted means the default model).',
  'rule is {kind:"once", at}, {kind:"daily", time:"HH:MM"}, {kind:"weekly", days:[1..7], time:"HH:MM"} (1 is Monday, 7 is Sunday) or {kind:"interval", everyMinutes}. For once, at is a millisecond timestamp or a local "YYYY-MM-DD HH:MM" string.',
  `Rules: an interval is at least ${MIN_INTERVAL_MINUTES} minutes; weekly needs at least one day; a once time must be in the future; times use the local time zone of the machine running Weft.`,
  'Nothing runs while Weft is closed. A run missed in that time is made up once when Weft starts again (not once per missed period); after that the schedule continues normally.',
  'If the target conversation is deleted, the schedule pauses itself. The user sees and can edit every schedule on the Scheduled Tasks page, including the ones you create.',
].join(' ');

const NAME_MAX = 200;

function reply(text, isError = false) {
  return { output: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Local "YYYY-MM-DD HH:MM". */
export function formatLocal(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const WEEKDAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function describeRule(rule) {
  if (rule.kind === 'once') return `once at ${formatLocal(rule.at)}`;
  if (rule.kind === 'daily') return `daily at ${rule.time}`;
  if (rule.kind === 'weekly') return `weekly on ${rule.days.map((day) => WEEKDAYS[day]).join(',')} at ${rule.time}`;
  return rule.everyMinutes % 60 === 0
    ? `every ${rule.everyMinutes / 60} hour${rule.everyMinutes === 60 ? '' : 's'}`
    : `every ${rule.everyMinutes} minutes`;
}

function describeTarget(target) {
  if (target.kind === 'conversation') return `conversation ${JSON.stringify(target.title || target.conversationId)} (${target.conversationId})`;
  const model = target.model ? `${target.model.providerId}/${target.model.modelId}` : 'default model';
  return `new conversation in ${JSON.stringify(target.workspaceName || target.workspaceId)} (${target.workspaceId}, ${model})`;
}

function nextText(schedule) {
  if (!schedule.enabled) return 'paused';
  return schedule.nextRunAt == null ? 'no next run' : `next run ${formatLocal(schedule.nextRunAt)}`;
}

/** `"name" (id: x)`. The thread view reads the id and the name back from this. */
function ident(schedule) {
  return `${JSON.stringify(schedule.name)} (id: ${schedule.id})`;
}

function listLine(schedule) {
  return `- ${ident(schedule)}: ${describeRule(schedule.rule)}, ${nextText(schedule)}, to ${describeTarget(schedule.target)}${schedule.createdBy === 'agent' ? ', created by agent' : ''}`;
}

/** Local date-time strings and timestamps for a once rule. Anything else is returned as given. */
function readOnceAt(at) {
  if (typeof at !== 'string') return at;
  const text = at.trim();
  if (/^\d{10,}$/.test(text)) return Number(text);
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (local) {
    return new Date(Number(local[1]), Number(local[2]) - 1, Number(local[3]), Number(local[4]), Number(local[5]), Number(local[6] || 0)).getTime();
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? at : parsed;
}

function ruleInput(rule) {
  if (rule && typeof rule === 'object' && rule.kind === 'once') return { ...rule, at: readOnceAt(rule.at) };
  return rule;
}

function failure(result) {
  const detail = result.body?.fields?.length ? ` (fields: ${result.body.fields.join(', ')})` : '';
  return reply(`${result.body?.error || 'failed'}${detail}`, true);
}

const TARGET = union([
  obj({ kind: lit('conversation'), conversationId: opt(str()) }),
  obj({
    kind: lit('new'),
    workspaceId: str(),
    model: opt(nullable(obj({ providerId: str(), modelId: str() }))),
  }),
]);

const RULE = union([
  obj({ kind: lit('once'), at: union([int(), str()]) }),
  obj({ kind: lit('daily'), time: str() }),
  obj({ kind: lit('weekly'), days: arr(int()), time: str() }),
  obj({ kind: lit('interval'), everyMinutes: int() }),
]);

/** `bridge.service` is filled in once the kernel is open. */
export function createScheduleTool(bridge) {
  return defineTool({
    name: SCHEDULE_TOOL_NAME,
    description: SCHEDULE_TOOL_DESCRIPTION,
    parameters: obj({
      action: union([lit('list'), lit('create'), lit('update'), lit('pause'), lit('resume'), lit('delete')]),
      id: opt(str()),
      name: opt(str({ maxLength: NAME_MAX })),
      message: opt(str()),
      target: opt(TARGET),
      rule: opt(RULE),
      enabled: opt(bool()),
    }),
    replay: 'unsafe',
    execute: async (args, api) => {
      const service = bridge.service;
      if (!service) return reply('Scheduled tasks are not available.', true);
      const { action } = args;

      if (action === 'list') {
        const all = await service.list();
        if (all.length === 0) return reply('No scheduled tasks.');
        return reply(all.map(listLine).join('\n'));
      }

      if (action === 'create') {
        const current = await service.conversationIdFor(api.conversationId);
        const result = await service.create({
          name: args.name,
          message: args.message,
          ...(args.target === undefined ? {} : { target: args.target }),
          rule: ruleInput(args.rule),
          ...(args.enabled === undefined ? {} : { enabled: args.enabled }),
        }, { createdBy: 'agent', lang: 'en', defaultConversation: current || undefined });
        if (result.status >= 400) return failure(result);
        const made = result.body;
        return reply(`Created schedule ${ident(made)}: ${describeRule(made.rule)}, ${nextText(made)}, to ${describeTarget(made.target)}.`);
      }

      if (!args.id) return reply(`${action} needs id. Use list to see the ids.`, true);

      if (action === 'delete') {
        const before = await service.get(args.id);
        const result = await service.remove(args.id, { lang: 'en' });
        if (result.status >= 400) return failure(result);
        return reply(`Deleted schedule ${before ? ident(before) : `(id: ${args.id})`}.`);
      }

      let patch;
      let verb;
      if (action === 'pause') { patch = { enabled: false }; verb = 'Paused'; }
      else if (action === 'resume') { patch = { enabled: true }; verb = 'Resumed'; }
      else {
        patch = {
          ...(args.name === undefined ? {} : { name: args.name }),
          ...(args.message === undefined ? {} : { message: args.message }),
          ...(args.target === undefined ? {} : { target: args.target }),
          ...(args.rule === undefined ? {} : { rule: ruleInput(args.rule) }),
          ...(args.enabled === undefined ? {} : { enabled: args.enabled }),
        };
        verb = 'Updated';
        if (Object.keys(patch).length === 0) return reply('update needs at least one of name, message, target, rule, enabled.', true);
      }
      const result = await service.update(args.id, patch, { lang: 'en' });
      if (result.status >= 400) return failure(result);
      const changed = result.body;
      return reply(`${verb} schedule ${ident(changed)}: ${describeRule(changed.rule)}, ${nextText(changed)}.`);
    },
  });
}
