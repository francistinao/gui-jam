import { appendFileSync, readFileSync } from 'node:fs';

const log = (entry) => {
  const file = process.env.GUIJAM_FAKE_OPENCODE_LOG;
  if (file) appendFileSync(file, `${JSON.stringify(entry)}\n`);
};
const print = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const args = process.argv.slice(2);

if (args[0] === '--version') {
  process.stdout.write('1.19.5\n');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'list') {
  process.stdout.write(
    '┌  Credentials ~/.local/share/opencode/auth.json\n│\n●  DeepSeek api\n│\n└  1 credential\n',
  );
  process.exit(0);
}
if (args[0] === 'models') {
  const model = (id, name, image) =>
    `${id}\n${JSON.stringify(
      {
        id: id.split('/')[1],
        name,
        status: 'active',
        cost: { input: 0.27, output: 1.1 },
        capabilities: { input: { text: true, image } },
      },
      null,
      2,
    )}\n`;
  process.stdout.write(
    model('deepseek/deepseek-chat', 'DeepSeek Chat', false) +
      model('zai/glm-4.6v', 'GLM-4.6V', true),
  );
  process.exit(0);
}
if (args[0] !== 'run') process.exit(2);

const message = process.stdin.isTTY ? '' : readFileSync(0, 'utf8');
if (message.trim() === '') {
  process.stderr.write('Error: You must provide a message or a command\n');
  process.exit(1);
}
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}');
const agent = config.agent?.[flag('--agent') ?? ''] ?? {};
const request = /^Request: (.*)$/m.exec(message)?.[1] ?? '';
const retry = message.includes('could not be used');
log({
  request,
  retry,
  model: flag('-m'),
  agent: flag('--agent'),
  pure: args.includes('--pure'),
  permission: agent.permission,
  mcp: config.mcp,
  schemaInPrompt: typeof agent.prompt === 'string' && agent.prompt.includes('"variants"'),
  isolatedConfig: process.env.XDG_CONFIG_HOME !== process.env.GUIJAM_TEST_CONFIG_HOME,
  projectConfigOff: process.env.OPENCODE_DISABLE_PROJECT_CONFIG === '1',
});

const [, file] = /^Element: <\w+> at (.+):\d+:\d+$/m.exec(message);
const [, baseHash] = /^base_hash: ([0-9a-f]{64})$/m.exec(message);
const variant = (label, style, rationale, find, replace) => ({
  label,
  system: 'Your project',
  style,
  rationale,
  missing: [],
  ops: [{ kind: 'replace_snippet', file, base_hash: baseHash, find, replace }],
});
const answer = {
  variants: [
    variant('Blue button', 'Solid', 'Swapped the brand fill for blue.', 'bg-brand', 'bg-[#2563EB]'),
    variant('Deep blue', 'Deep', 'A darker blue.', 'bg-brand', 'bg-[#1D4ED8]'),
  ],
};
const text =
  /unusable/i.test(request) && !retry
    ? 'I would make the button blue and keep the radius.'
    : `Here are two takes:\n\`\`\`json\n${JSON.stringify(answer, null, 2)}\n\`\`\`\nBoth keep the label.`;

print({ type: 'step_start', part: { type: 'step-start' } });
print({ type: 'text', part: { type: 'text', text } });
print({ type: 'step_finish', part: { type: 'step-finish', reason: 'stop', cost: 0.0004 } });
