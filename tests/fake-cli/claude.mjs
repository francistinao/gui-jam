// A stand-in for `claude` that answers like Claude Code 2.1.325 in headless
// stream-json mode, so e2e runs exercise the real adapter without spending tokens.
// It answers three recolourings of the element it is asked about. Words in the request
// change that: "slow" never answers (cancellation), "crash" exits without an answer,
// "invalid" makes the second variant miss its snippet, and "pause" answers after 1.5 s. With GUIJAM_FAKE_CLAUDE_LOG
// set it appends what it was run with, and when it was interrupted.
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
} else if (/crash/i.test(text)) {
  process.stderr.write('fake claude: crashed\n');
  process.exit(1);
} else {
  if (/pause/i.test(text)) await new Promise((resolve) => setTimeout(resolve, 1500));
  const [, file] = /^Element: <\w+> at (.+):\d+:\d+$/m.exec(text);
  const [, baseHash] = /^base_hash: ([0-9a-f]{64})$/m.exec(text);
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
    structured_output: {
      variants: [
        variant(
          'Blue button',
          'Solid',
          'Swapped the brand fill for blue.',
          'bg-brand',
          'bg-[#2563EB]',
        ),
        // "invalid" in the prompt makes this one miss, so the daemon drops it.
        /invalid/i.test(text)
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
