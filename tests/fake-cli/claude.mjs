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
const images = message.message.content.filter((part) => part.type === 'image');
const sizeOf = (image) => {
  const bytes = Buffer.from(image.source.data, 'base64');
  if (image.source.media_type === 'image/png') {
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  for (let at = 2; at + 9 < bytes.length; ) {
    const marker = bytes[at + 1];
    const length = bytes.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xc3)
      return [bytes.readUInt16BE(at + 7), bytes.readUInt16BE(at + 5)];
    at += 2 + length;
  }
  return null;
};
const sketched = text.includes('<sketch');
log({
  args,
  request,
  images: images.map((image) => image.source.media_type),
  imageSizes: images.map(sizeOf),
  inspiration: /<inspiration images="([^"]+)">/.exec(text)?.[1] ?? null,
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
  if (/stepwise/i.test(request)) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    print({ type: 'stream_event', event: { type: 'message_start' } });
    print({ type: 'stream_event', event: { type: 'content_block_start' } });
    for (let chunk = 0; chunk < 3; chunk += 1) {
      print({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: 'x'.repeat(1100) },
        },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (/linger/i.test(request)) await new Promise((resolve) => setTimeout(resolve, 4000));
  const icon = /\b(star|leaf)\b/i.exec(request)?.[1]?.toLowerCase() ?? 'cup';
  const iconName = `${icon[0].toUpperCase()}${icon.slice(1)} icon`;
  const cardText = icon === 'cup' ? 'Sketched card' : `Sketched ${icon} card`;
  const sketchedCard = `<OrderButton />\n            <span className="flex items-center gap-2 rounded-card bg-white px-4 py-2 shadow"><img src={${icon}Icon} alt="${iconName}" className="size-6" />${cardText}</span>`;
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
    structured_output: sketched
      ? {
          variants: [
            {
              ...variant(
                cardText,
                'Card',
                `A card with a ${icon} icon, built from the sketch.`,
                '<OrderButton />',
                sketchedCard,
              ),
              ops: [
                {
                  kind: 'replace_snippet',
                  file,
                  base_hash: baseHash,
                  find: "import { Counter } from './components/Counter';",
                  replace: `import ${icon}Icon from './assets/icons/${icon}-icon.svg';\nimport { Counter } from './components/Counter';`,
                },
                {
                  kind: 'replace_snippet',
                  file,
                  base_hash: baseHash,
                  find: '<OrderButton />',
                  replace: sketchedCard,
                },
              ],
              assets: [
                {
                  name: `${icon}-icon`,
                  format: 'svg',
                  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z" fill="#3b2418"/></svg>',
                },
              ],
            },
          ],
        }
      : headerImage
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
