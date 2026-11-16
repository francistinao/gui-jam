import { appendFileSync } from 'node:fs';

const log = (entry) => {
  const file = process.env.GUIJAM_FAKE_CLAUDE_LOG;
  if (file) appendFileSync(file, `${JSON.stringify(entry)}\n`);
};
const print = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const args = process.argv.slice(2);

if (args[0] === '--version') {
  process.stdout.write('2.1.325 (Claude Code)\n');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(`${JSON.stringify({ loggedIn: true })}\n`);
  process.exit(0);
}

let input = '';
for await (const chunk of process.stdin) input += chunk;
const message = JSON.parse(input.trim().split('\n')[0]);
const text = message.message.content.find((part) => part.type === 'text').text;
const request = /^Request: (.*)$/m.exec(text)?.[1] ?? '';
log({
  args,
  request,
  assets: [...text.matchAll(/ · asset (\S+)/g)].map((match) => match[1]),
});

print({ type: 'system', subtype: 'init' });

if (/slow/i.test(request)) {
  process.on('SIGINT', () => {
    log({ interrupted: true });
    process.exit(130);
  });
  setInterval(() => {}, 1000);
} else if (/crash/i.test(request)) {
  process.stderr.write('fake claude: crashed\n');
  process.exit(1);
} else if (request.endsWith('?')) {
  const [, at] = /^Element: <\w+> at (.+:\d+):\d+$/m.exec(text);
  print({
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0,
    structured_output: { answer: `It is rendered at ${at}.`, variants: [] },
  });
} else {
  if (/pause/i.test(request)) await new Promise((resolve) => setTimeout(resolve, 1500));
  const [, file] = /^Element: <\w+> at (.+):\d+:\d+$/m.exec(text);
  const [, baseHash] = /^base_hash: ([0-9a-f]{64})$/m.exec(text);
  const headerImage = /image/i.test(request)
    ? /^- header > img \(image\).* · asset (\S+)/m.exec(text)?.[1]
    : undefined;
  const variant = (label, style, rationale, find, replace) => ({
    label,
    system: 'Your project',
    style,
    rationale,
    missing: [],
    ops: [{ kind: 'replace_snippet', file, base_hash: baseHash, find, replace }],
  });
  print({
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0,
    structured_output: headerImage
      ? {
          variants: [
            variant(
              'Header image',
              'Icon',
              'Adds the header image before the label.',
              'Order now',
              `<img src="${headerImage.replace(/^public/, '')}" alt="" className="size-4" />Order now`,
            ),
          ],
        }
      : {
          variants: [
            variant(
              'Blue button',
              'Solid',
              'Swapped the brand fill for blue.',
              'bg-brand',
              'bg-[#2563EB]',
            ),
            /invalid/i.test(request)
              ? variant('Deep blue', 'Deep', 'A darker blue.', 'bg-nowhere', 'bg-[#1D4ED8]')
              : variant('Deep blue', 'Deep', 'A darker blue.', 'bg-brand', 'bg-[#1D4ED8]'),
            variant(
              'Outline',
              'Outline',
              'A white button with a blue border.',
              'bg-brand',
              'border-2 border-[#2563EB] bg-white',
            ),
          ],
        },
  });
}
