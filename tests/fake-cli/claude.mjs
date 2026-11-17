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
const field = (block, name) => new RegExp(`^${name}: (.*)$`, 'm').exec(block)?.[1] ?? null;
const links = [
  ...text.matchAll(/<link url="([^"]*)"((?: \w+="[^"]*")*)>\n([\s\S]*?)<\/link>/g),
].map(([, url, attrs, body]) => ({
  url,
  final: / final="([^"]*)"/.exec(attrs)?.[1] ?? null,
  error: / error="([^"]*)"/.exec(attrs)?.[1] ?? null,
  title: field(body, 'Title'),
  colors: field(body, 'Colors'),
  variables: field(body, 'Color variables'),
  fonts: field(body, 'Fonts'),
  image: /^(Image \d+ is .*)$/m.exec(body)?.[1] ?? null,
  text: /^Text:\n([\s\S]*)$/.exec(body.slice(body.indexOf('Text:\n')))?.[1]?.trim() ?? null,
}));
log({
  args,
  request,
  images: images.map((image) => image.source.media_type),
  imageSizes: images.map(sizeOf),
  inspiration: /<inspiration images="([^"]+)">/.exec(text)?.[1] ?? null,
  newUi: /<new-ui components="([^"]+)"/.exec(text)?.[1] ?? null,
  links,
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
  const create = (path, content) => ({ kind: 'create_file', file: path, content });
  const edit = (find, replace) => ({
    kind: 'replace_snippet',
    file,
    base_hash: baseHash,
    find,
    replace,
  });
  const pricing = {
    variants: [
      {
        ...variant('Pricing section', 'Split', 'Atoms, molecules and an organism.', '', ''),
        ops: [
          edit(
            'export function OrderButton() {',
            "import { PricingSection } from './organisms/PricingSection';\n\nexport function OrderButton() {",
          ),
          edit('  return (\n    <button', '  return (\n    <>\n    <button'),
          edit('    </button>\n  );', '    </button>\n    <PricingSection />\n    </>\n  );'),
          create(
            'src/components/atoms/Price.tsx',
            'interface PriceProps {\n  amount: string;\n}\n\nexport function Price({ amount }: PriceProps) {\n  return <span className="text-2xl font-semibold">{amount}</span>;\n}\n',
          ),
          create(
            'src/components/molecules/PlanCard.tsx',
            'import { Price } from \'../atoms/Price\';\n\ninterface PlanCardProps {\n  name: string;\n  amount: string;\n}\n\nexport function PlanCard({ name, amount }: PlanCardProps) {\n  return (\n    <article className="rounded-card bg-white p-4 shadow">\n      <h3>{name}</h3>\n      <Price amount={amount} />\n    </article>\n  );\n}\n',
          ),
          create(
            'src/components/organisms/PricingSection.tsx',
            'import { PlanCard } from \'../molecules/PlanCard\';\n\nexport function PricingSection() {\n  return (\n    <section aria-label="Pricing" className="flex gap-4">\n      <PlanCard name="Starter" amount="$9" />\n      <PlanCard name="Pro" amount="$19" />\n    </section>\n  );\n}\n',
          ),
        ],
      },
      {
        ...variant('Rule breaker', 'Page', 'Puts the section in a page.', '', ''),
        ops: [
          edit('bg-brand', 'bg-sea'),
          create(
            'src/pages/Pricing.tsx',
            'export function Pricing() {\n  return <section>Plans</section>;\n}\n',
          ),
        ],
      },
      variant(
        'Inline price',
        'Inline',
        'Adds the price to the label.',
        'Order now',
        'Order now · from $9',
      ),
    ],
  };
  print({
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0,
    structured_output: /pricing/i.test(request)
      ? pricing
      : sketched
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
