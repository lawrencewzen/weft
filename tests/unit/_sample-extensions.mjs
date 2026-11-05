// Test-only copies of the old sample plugin and skills. The intranet package
// does not ship them; tests write these into a temporary directory.
import fs from 'node:fs/promises';
import path from 'node:path';

export const SAMPLE_COMMIT_SKILL = {
  id: 'commit-message',
  name: 'Commit messages',
  description: "Write a commit subject and body that state the why, in the user's language.",
  body: [
    'When the user asks for a commit message, changelog line, or a summary of a change:',
    '',
    "- Use the user's language.",
    '- Subject line is imperative, about 50 characters, and names the outcome.',
    '- The body explains why the change exists. Do not restate the diff file by file.',
    '- If the diff is unknown, say what is missing instead of inventing files, commands, or ticket ids.',
    '- Do not add trailers or co-authors the user did not supply.',
  ].join('\n'),
};

export const SAMPLE_REVIEW_SKILL = {
  id: 'review-notes',
  name: 'Review notes',
  description: 'Review code as a short list of findings ordered by severity.',
  body: [
    'When the user asks for a code review, an audit, or what is wrong with a change:',
    '',
    '- Lead with findings, highest severity first. Each finding is one short paragraph: what is wrong, where, and what to change.',
    '- Severity is only "blocker", "should fix", or "note".',
    '- If nothing important is wrong, say so in one sentence and mention residual risk.',
    '- Do not praise the change, restate the diff, or propose a rewrite that the findings do not require.',
  ].join('\n'),
};

function quoteMeta(value) {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/"/g, "'").trim();
  return `"${text}"`;
}

async function writeSkill(root, skill) {
  const dir = path.join(root, skill.id);
  await fs.mkdir(dir, { recursive: true });
  const text = [
    '---',
    `id: ${quoteMeta(skill.id)}`,
    `name: ${quoteMeta(skill.name)}`,
    `description: ${quoteMeta(skill.description)}`,
    'version: "1.0.0"',
    'source: "bundled"',
    '---',
    '',
    skill.body.trim(),
    '',
  ].join('\n');
  await fs.writeFile(path.join(dir, 'SKILL.md'), text, 'utf8');
}

/** Write commit-message and review-notes under `root` (a skills directory). */
export async function writeSampleSkills(root) {
  await fs.mkdir(root, { recursive: true });
  await writeSkill(root, SAMPLE_COMMIT_SKILL);
  await writeSkill(root, SAMPLE_REVIEW_SKILL);
  return root;
}

/** Write the echo plugin under `root` (a plugins directory). Returns the plugin folder. */
export async function writeSampleEcho(root) {
  const dir = path.join(root, 'echo');
  await fs.mkdir(dir, { recursive: true });
  const manifest = {
    id: 'echo',
    name: 'Echo',
    description: '返回传入的文本，用来确认插件已加载。Returns the text you pass it.',
    version: '0.1.0',
    source: 'bundled',
    main: 'index.mjs',
    tools: [{
      name: 'echo',
      description: 'Return the given text unchanged. Does not read files or run commands.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Text to return, at most 4000 characters.',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
    }],
  };
  await fs.writeFile(path.join(dir, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(dir, 'index.mjs'), `const MAX = 4000;

export async function echo(args) {
  const text = args && typeof args.text === 'string' ? args.text : '';
  if (!text) return { output: 'echo: text is required', status: 'error' };
  if (text.length > MAX) return { output: 'echo: text is too long', status: 'error' };
  return { output: text, status: 'completed' };
}
`);
  return dir;
}
