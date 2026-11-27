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
const numbers = (list) => list.split(',').map(Number);
const over = /<sketch on="([^"]+)" element-box="([^"]+)" box="([^"]+)">/.exec(text);
const space = /<sketch box="([^"]+)">/.exec(text);
const sketch = over
  ? { on: over[1], elementBox: numbers(over[2]), box: numbers(over[3]) }
  : space
    ? { on: null, elementBox: null, box: numbers(space[1]) }
    : null;
const group = [...text.matchAll(/^- <\w+> at (.+):(\d+):(\d+), base_hash: ([0-9a-f]{64})/gm)].map(
  ([, path, line, column, hash]) => ({ path, line: Number(line), column: Number(column), hash }),
);
const shown = [
  ...text.matchAll(
    /<file path="([^"]+)" base_hash="([0-9a-f]{64})" lines="[^"]*" why="([^"]+)"(?: whole="true")?>/g,
  ),
].map(([, path, hash, why]) => ({ path, hash, why }));
const shownFile = (why) => shown.find((file) => why.test(file.why));
const component = /^Component: (.*)$/m.exec(text)?.[1] ?? null;
const layout = text.includes('is a layout that renders the routed page');
const direction = /^Direction: (.*)$/m.exec(text)?.[1] ?? null;
const slot =
  direction === null
    ? null
    : direction.startsWith('a distinctly different')
      ? 1
      : direction.startsWith('the simplest')
        ? 2
        : 0;
const pick = (answer) =>
  slot === null || !Array.isArray(answer.variants)
    ? answer
    : { ...answer, variants: answer.variants[slot] ? [answer.variants[slot]] : [] };
const field = (block, name) => new RegExp(`^${name}: (.*)$`, 'm').exec(block)?.[1] ?? null;
const componentsBlock = /<components for="([^"]+)">\n([\s\S]*?)<\/components>/.exec(text);
const listed = componentsBlock
  ? [
      ...componentsBlock[2].matchAll(
        /^- (\S+) · ([^·]+) · (\S+):(\d+) · ([^\n]+)\n {2}(import [^\n]+|no import needed[^\n]*)\n {2}props: ([^\n]*)\n/gm,
      ),
    ].map(([, name, scope, path, , used, importLine, props]) => ({
      name,
      scope: scope.trim(),
      path,
      used,
      import: importLine.startsWith('import ') ? importLine : null,
      props,
    }))
  : [];
const previousAttempt = /<previous-attempt>\n[^\n]*\n((?:- [^\n]*\n)*)/.exec(text);
const repairReasons = previousAttempt
  ? previousAttempt[1]
      .split('\n')
      .filter(Boolean)
      .map((reason) => reason.slice(2))
  : [];
const wholeSource = /<source file="[^"]+" lines="[^"]+" whole="true">/.test(text);
const componentSources = [...text.matchAll(/<component-source path="([^"]+)"/g)].map(
  (match) => match[1],
);
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
  file: field(body, 'File'),
  spacing: field(body, 'Spacing and radii'),
  code: [
    ...body.matchAll(/<code(?: lang="([^"]*)")? end="([^"]+)">\n([\s\S]*?)<\/code end="\2">/g),
  ].map(([, lang, , code]) => ({ lang: lang ?? null, code })),
  pages: [...body.matchAll(/<page url="([^"]*)">/g)].map((match) => match[1]),
}));
const figma = [
  ...text.matchAll(
    /<figma url="([^"]*)" file="([^"]*)" node="([^"]*)"[^>]*>\n([\s\S]*?)<\/figma>/g,
  ),
].map(([, url, file, node, body]) => ({
  url,
  file,
  node,
  frame: field(body, 'Frame'),
  image: /^(Image \d+ is .*)$/m.exec(body)?.[1] ?? null,
  layers: /Layers \(exact values\):\n([\s\S]*?)\nNot in the frame/.exec(body)?.[1] ?? null,
}));
log({
  pid: process.pid,
  args,
  request,
  slot,
  gitInstructions: process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS !== '1',
  images: images.map((image) => image.source.media_type),
  imageSizes: images.map(sizeOf),
  imageBytes: images.map((image) => image.source.data.length),
  inspiration: /<inspiration images="([^"]+)">/.exec(text)?.[1] ?? null,
  newUi: /<new-ui components="([^"]+)"/.exec(text)?.[1] ?? null,
  copies: /^Copies: (.*)$/m.exec(text)?.[1] ?? null,
  libraries: /<libraries installed="([^"]*)">/.exec(text)?.[1] ?? null,
  links,
  figma,
  assets: [...text.matchAll(/ · asset (\S+)/g)].map((match) => match[1]),
  sketch,
  closeUp: text.includes('is a close-up of the element'),
  files: shown.map(({ path, why }) => ({ path, why })),
  component,
  layout,
  alsoSelected: group.map(({ path, line, column }) => `${path}:${line}:${column}`),
  components: componentsBlock ? { for: componentsBlock[1], listed } : null,
  componentSources,
  previousAttempt: previousAttempt !== null,
  repairReasons,
  wholeSource,
});

print({ type: 'system', subtype: 'init' });

if (/slow/i.test(request) || (/staggered/i.test(request) && slot === 2)) {
  process.on('SIGINT', () => {
    log({ interrupted: true, request, slot });
    process.exit(130);
  });
  setInterval(() => {}, 1000);
} else if (/crash/i.test(request)) {
  process.stderr.write('fake claude: crashed\n');
  process.exit(1);
} else if (request.endsWith('?')) {
  const [, at] = /^Element: <\w+> at (.+:\d+):\d+$/m.exec(text);
  const answer = /\blong\b/i.test(request)
    ? `**Right column:** wrap it in src/features/core-hr/dashboard/components/organisms/EmployeeDashboardRightColumnWithOnboardingTasks.tsx:106 and give the grid @4xl/content:grid-cols-[1fr_500px]_supercalifragilisticexpialidocious so it keeps its width. It is rendered at ${at}.`
    : `It is rendered at ${at}.`;
  print({
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0,
    structured_output: { answer, variants: [] },
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
  const [, file, line, column] = /^Element: <\w+> at (.+):(\d+):(\d+)$/m.exec(text);
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
  const placesCopy = shownFile(/^places this copy/);
  const redesign = {
    variants: [1, 2, 3].map((index) => ({
      ...variant(`Special ${index}`, 'Feature', 'A featured card for this copy.', '', ''),
      ops: [
        ...(placesCopy
          ? [
              {
                kind: 'replace_snippet',
                file: placesCopy.path,
                base_hash: placesCopy.hash,
                find: "import { MenuCard } from './components/MenuCard';",
                replace: `import { MenuCard } from './components/MenuCard';\nimport { SpecialCard${index} } from './components/organisms/SpecialCard${index}';`,
              },
              {
                kind: 'replace_snippet',
                file: placesCopy.path,
                base_hash: placesCopy.hash,
                find: '<h2 className="text-xl font-semibold">Today’s menu</h2>',
                replace: `<h2 className="text-xl font-semibold">Today’s menu</h2>\n          <SpecialCard${index} />`,
              },
            ]
          : []),
        create(
          `src/components/organisms/SpecialCard${index}.tsx`,
          `export function SpecialCard${index}() {\n  return (\n    <section aria-label="Special" className="rounded-card bg-white p-6">\n      Chef’s special ${index}\n    </section>\n  );\n}\n`,
        ),
      ],
    })),
  };
  const grouped = {
    variants: ['V1', 'V2', 'V3'].map((name, index) => ({
      label: `Grouped ${name}`,
      system: 'Your project',
      style: ['Solid', 'Soft', 'Plain'][index],
      rationale: 'Marks every selected element.',
      missing: [],
      ops: [{ path: file, line, column, hash: baseHash }, ...group].map((target) => ({
        kind: 'jsx_attr',
        file: target.path,
        base_hash: target.hash,
        at: { line: Number(target.line), column: Number(target.column) },
        name: 'data-grouped',
        value: { string: name },
      })),
    })),
  };
  const sketchedOver = {
    variants: ['V1', 'V2', 'V3'].map((name, index) => ({
      label: `Sketched ${name}`,
      system: 'Your project',
      style: ['Pill', 'Ring', 'Plain'][index],
      rationale: 'Follows the sketch over the selected element.',
      missing: [],
      ops: [
        {
          kind: 'jsx_attr',
          file,
          base_hash: baseHash,
          at: { line: Number(line), column: Number(column) },
          name: 'data-sketched',
          value: { string: name },
        },
      ],
    })),
  };
  const scene = {
    variants: [
      {
        ...variant('Scene', 'Scene', 'Shows the three.js revision on the button.', '', ''),
        ops: [
          edit(
            'export function OrderButton() {',
            "import { REVISION } from 'three';\n\nexport function OrderButton() {",
          ),
          edit('      Order now', '      Order now · r{REVISION}'),
        ],
      },
      variant('CSS only', 'Css', 'A deeper fill without a library.', 'bg-brand', 'bg-[#1D4ED8]'),
      {
        ...variant('Padded', 'Pad', 'Uses a package that is not installed.', '', ''),
        ops: [
          edit(
            'export function OrderButton() {',
            "import pad from 'left-pad-pro';\n\nexport function OrderButton() {",
          ),
          edit('      Order now', '      {pad("Order now")}'),
        ],
      },
    ],
  };
  const replaceIn = (target, find, replace) => ({
    kind: 'replace_snippet',
    file: target.path,
    base_hash: target.hash,
    find,
    replace,
  });
  const selectedSource = [
    ...text.matchAll(
      /<(?:source|imports) file="[^"]+" lines="[^"]+"(?: whole="true")?>\n([\s\S]*?)<\/(?:source|imports)>/g,
    ),
  ]
    .map((match) => match[1])
    .join('\n');
  const selectedLine = new RegExp(`^\\s*${line} \\| (.*)$`, 'm').exec(selectedSource)?.[1] ?? '';
  const inline = /<(\w+)[^>]*>([^<]*)<\/\1>/.exec(selectedLine);
  const swapIn = (target, importLine) => {
    if (!inline) return null;
    const [markup, , inner] = inline;
    const tag = /import \{?\s*(\w+)/.exec(importLine ?? '')?.[1] ?? target.name;
    const usage = /\bmessage\b/.test(target.props)
      ? `<${tag} message="${inner}" />`
      : `<${tag}>${inner}</${tag}>`;
    const source = importLine ? /from ["']([^"']+)["']/.exec(importLine)?.[1] : null;
    const already =
      !source ||
      selectedSource.includes(`from '${source}'`) ||
      selectedSource.includes(`from "${source}"`);
    const ops = [edit(markup, usage)];
    const anchor = /^\s*\d+ \| (export (?:default )?function \w+|<script setup[^>]*>)/m.exec(
      selectedSource,
    )?.[1];
    if (!already && anchor) {
      ops.push(
        edit(
          anchor,
          anchor.startsWith('<script') ? `${anchor}\n${importLine}` : `${importLine}\n\n${anchor}`,
        ),
      );
    }
    return ops;
  };
  const sourceBlock =
    /<source file="[^"]+" lines="[^"]+"(?: whole="true")?>\n([\s\S]*?)<\/source>/.exec(text)?.[1];
  const rebuilt = sourceBlock
    ?.split('\n')
    .slice(0, -1)
    .map((numbered) => numbered.replace(/^\s*\d+ \| ?/, ''))
    .join('\n');
  const rewriteOf = (label, style, from, to) => ({
    ...variant(label, style, `Rewrote the whole file: ${from} became ${to}.`, '', ''),
    ops: [
      {
        kind: 'rewrite_file',
        file,
        base_hash: baseHash,
        content: (rebuilt ?? '').replace(from, to),
      },
    ],
  });
  const rewriting =
    /\brewrite\b/i.test(request) && rebuilt !== undefined
      ? {
          variants: [
            rewriteOf('Rounder', 'Rewrite', 'rounded-card', 'rounded-3xl'),
            rewriteOf('Deeper', 'Shadow', 'shadow-sm', 'shadow-lg'),
            rewriteOf('Roomier', 'Space', 'p-6', 'p-8'),
          ],
        }
      : null;
  const misquoted = (index) =>
    variant(
      `Guess ${index}`,
      'Guess',
      'Quotes code that is not there.',
      `bg-nowhere-${index}`,
      'bg-sea',
    );
  const broken =
    /\bhopeless\b/i.test(request) || (/\bflaky\b/i.test(request) && previousAttempt === null)
      ? { variants: [misquoted(1), misquoted(2), misquoted(3)] }
      : null;
  const reuse =
    listed.length > 0 && inline && /\b(existing|reuse|search)\b|match the rest/i.test(request)
      ? {
          variants: [
            {
              ...variant(`Uses ${listed[0].name}`, 'Reuse', `Uses ${listed[0].name}.`, '', ''),
              ops: swapIn(listed[0], listed[0].import),
            },
            {
              ...variant(
                'Made-up import',
                'Guess',
                'Imports a component that is not there.',
                '',
                '',
              ),
              ops: swapIn(
                { name: 'ErrorMsg', props: listed[0].props },
                "import { ErrorMsg } from './components/ErrorMsg';",
              ),
            },
            variant(
              'Larger text',
              'Plain',
              'Keeps the markup and enlarges the text.',
              inline[0],
              inline[0].replace(/\btext-xs\b/, 'text-sm'),
            ),
          ],
        }
      : null;
  const renders = shownFile(/^renders OrderButton$/);
  const card = shown.find((file) => file.path.endsWith('MenuCard.tsx'));
  const page = shownFile(/^holds the routed page next to the sketch$/);
  const appImport = "import { OrderButton } from './components/OrderButton';";
  const crossFile =
    renders && /\bremove this\b/i.test(request)
      ? {
          variants: [
            {
              ...variant(
                'Removed',
                'Gone',
                'Removes the order button where App renders it.',
                '',
                '',
              ),
              ops: [
                replaceIn(renders, `${appImport}\n`, ''),
                replaceIn(renders, '            <OrderButton />\n', ''),
              ],
            },
          ],
        }
      : renders && card && /\bmove this into the menu card\b/i.test(request)
        ? {
            variants: [
              {
                ...variant('In the cards', 'Moved', 'Each menu card orders with it.', '', ''),
                ops: [
                  replaceIn(renders, `${appImport}\n`, ''),
                  replaceIn(renders, '            <OrderButton />\n', ''),
                  replaceIn(
                    card,
                    "import type { ComponentProps } from 'react';",
                    "import type { ComponentProps } from 'react';\nimport { OrderButton } from './OrderButton';",
                  ),
                  replaceIn(
                    card,
                    '<span className="font-semibold">₱{price}</span>',
                    '<span className="font-semibold">₱{price}</span>\n        <OrderButton />',
                  ),
                ],
              },
            ],
          }
        : renders && /\bcomment this out\b/i.test(request)
          ? {
              variants: [
                {
                  ...variant('Commented out', 'Hidden', 'Comments out the order button.', '', ''),
                  ops: [
                    replaceIn(renders, appImport, `// ${appImport}`),
                    replaceIn(
                      renders,
                      '            <OrderButton />',
                      '            {/* <OrderButton /> */}',
                    ),
                  ],
                },
              ],
            }
          : layout && page
            ? {
                variants: [
                  {
                    ...variant(
                      'Promo banner',
                      'Banner',
                      'Puts the sketched banner on the page.',
                      '',
                      '',
                    ),
                    ops: [
                      create(
                        'app/components/organisms/PromoBanner.tsx',
                        'export function PromoBanner() {\n  return <aside className="rounded-card bg-white p-4 shadow">Free pastry with any latte</aside>;\n}\n',
                      ),
                      replaceIn(
                        page,
                        'export default function Orders() {',
                        "import { PromoBanner } from '../components/organisms/PromoBanner';\n\nexport default function Orders() {",
                      ),
                      replaceIn(
                        page,
                        '<p className="rounded-card bg-latte p-4">No orders yet.</p>',
                        '<p className="rounded-card bg-latte p-4">No orders yet.</p>\n      <PromoBanner />',
                      ),
                    ],
                  },
                ],
              }
            : null;
  if (slot) await new Promise((resolve) => setTimeout(resolve, slot * 150));
  print({
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0,
    structured_output: pick(
      group.length > 0
        ? grouped
        : crossFile
          ? crossFile
          : rewriting
            ? rewriting
            : broken
              ? broken
              : reuse
                ? reuse
                : /\bredesign\b/i.test(request)
                  ? redesign
                  : /\b3d\b/i.test(request)
                    ? scene
                    : /pricing/i.test(request)
                      ? pricing
                      : over
                        ? sketchedOver
                        : sketched
                          ? {
                              variants: Array.from(
                                { length: /\btwin\b/i.test(request) ? 2 : 1 },
                                () => ({
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
                                }),
                              ),
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
                                    ? variant(
                                        'Deep blue',
                                        'Deep',
                                        'A darker blue.',
                                        'bg-nowhere',
                                        'bg-[#1D4ED8]',
                                      )
                                    : variant(
                                        'Deep blue',
                                        'Deep',
                                        'A darker blue.',
                                        'bg-brand',
                                        'bg-[#1D4ED8]',
                                      ),
                                  variant(
                                    'Outline',
                                    'Outline',
                                    'A white button with a blue border.',
                                    'bg-brand',
                                    'border-2 border-[#2563EB] bg-white',
                                  ),
                                ],
                              },
    ),
  });
}
