// A stand-in for `claude` that answers like Claude Code 2.1.325 in headless
// stream-json mode, so e2e runs exercise the real adapter without spending tokens.
// It recolours the element it is asked about; a request mentioning "slow" never
// answers, for cancellation tests. With GUIJAM_FAKE_CLAUDE_LOG set it appends what it
// was run with, and when it was interrupted.
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
log({ args, request: /^Request: (.*)$/m.exec(text)?.[1] });

print({ type: 'system', subtype: 'init' });

if (/slow/i.test(text)) {
  process.on('SIGINT', () => {
    log({ interrupted: true });
    process.exit(130);
  });
  setInterval(() => {}, 1000);
} else {
  const [, file] = /^Element: <\w+> at (.+):\d+:\d+$/m.exec(text);
  const [, baseHash] = /^base_hash: ([0-9a-f]{64})$/m.exec(text);
  print({
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0,
    structured_output: {
      variants: [
        {
          label: 'Blue button',
          system: 'project',
          style: 'solid',
          rationale: 'Swapped the brand fill for blue.',
          missing: [],
          ops: [
            {
              kind: 'replace_snippet',
              file,
              base_hash: baseHash,
              find: 'bg-brand',
              replace: 'bg-[#2563EB]',
            },
          ],
        },
      ],
    },
  });
}
