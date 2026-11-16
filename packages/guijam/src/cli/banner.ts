export type ColorDepth = 'none' | '256' | 'truecolor';

type Ink = 'b' | 'o' | 'p' | 'g' | 'k';

const LOGO = [
  '............................p...',
  '............................p...',
  '.............oo............ppp..',
  '...........ooooooo.......ppppppp',
  '...........ooooooooo......ppppp.',
  '.......bbb.oooooooooo..ppp..p...',
  '....bbbbbboooooo.......pppp.p...',
  '..bbbbbbb.oooo..ggggggg.pppp....',
  'bbbbbbbbb.oo.gggggggggg.ppppp...',
  'bbbbbbbbbo.ggggg....gggggg.ppp..',
  'bbbbbbbb..gggg......ggggggg.ppp.',
  'bbbbbbb.gggg.kkk.........ggg.pp.',
  '.bbbbb.ggg....kkkk........gggpp.',
  '.bbbb.ggg.....kkkkkkk......ggpp.',
  '.bbb.ggg.o....kkkkkkkkk....ggpp.',
  '.bbbggg.oo.....kkkkkkk....gggpp.',
  '..b.gg.ooo.....kkkkkk.....gg.p..',
  '..b.gg.oooo....kkkkkk....gggpp..',
  '..b.gg.oooo.....kk.kkk..ggg.pp..',
  '..bbggg.ooo.....k...kk.ggg.ppp..',
  '...b.gggg.............ggg.pppp..',
  '...bb.ggggggggggg...gggg.pppp...',
  '...bbbb.gggggggg..ggggg.ppppp...',
  '....bbbbbboo...gggggg.ppppppp...',
  '....bbbbbb....ggggg..pppppppp...',
  '.....bb........g........pppp....',
];

const TRUECOLOR: Record<Ink, string> = {
  b: '2;10;155;255',
  o: '2;255;87;34',
  p: '2;160;60;245',
  g: '2;18;212;110',
  k: '',
};

const XTERM: Record<Ink, string> = {
  b: '5;33',
  o: '5;202',
  p: '5;99',
  g: '5;41',
  k: '',
};

const WORDMARK = [
  ['█▀▀ █ █ █', '   █ ▄▀█ █▀▄▀█'],
  ['█▄█ █▄█ █', ' █▄█ █▀█ █ ▀ █'],
];

const TAGLINE = 'Draw on your app. Keep what you like.';
const GAP = 3;

export interface BannerOptions {
  version: string;
  depth: ColorDepth;
  columns: number;
}

export function colorDepth(env: NodeJS.ProcessEnv, isTTY: boolean): ColorDepth {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'none';
  if (env.FORCE_COLOR === '0' || env.TERM === 'dumb') return 'none';
  if (!isTTY && env.FORCE_COLOR === undefined) return 'none';
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit' || env.FORCE_COLOR === '3') {
    return 'truecolor';
  }
  return '256';
}

function isInk(value: string | undefined): value is Ink {
  return value === 'b' || value === 'o' || value === 'p' || value === 'g' || value === 'k';
}

function sgr(codes: string[], text: string): string {
  return `\x1b[${codes.join(';')}m${text}\x1b[0m`;
}

function cell(top: string | undefined, bottom: string | undefined, depth: ColorDepth): string {
  const table = depth === 'truecolor' ? TRUECOLOR : XTERM;
  const fg = (ink: Ink): string => (ink === 'k' ? '39' : `38;${table[ink]}`);
  const bg = (ink: Ink): string => `48;${table[ink]}`;
  const upper = isInk(top) ? top : undefined;
  const lower = isInk(bottom) ? bottom : undefined;
  if (upper === undefined && lower === undefined) return ' ';
  if (lower === undefined) return upper === undefined ? ' ' : sgr([fg(upper)], '▀');
  if (upper === undefined) return sgr([fg(lower)], '▄');
  if (upper === lower) return sgr([fg(upper)], '█');
  if (lower === 'k') return sgr([fg(lower), bg(upper)], '▄');
  return sgr([fg(upper), bg(lower)], '▀');
}

function logoLines(depth: ColorDepth): string[] {
  const lines: string[] = [];
  for (let row = 0; row < LOGO.length; row += 2) {
    const top = LOGO[row] ?? '';
    const bottom = LOGO[row + 1] ?? '';
    let line = '';
    for (let column = 0; column < top.length; column += 1) {
      line += cell(top[column], bottom[column], depth);
    }
    lines.push(line);
  }
  return lines;
}

function textLines(version: string): string[] {
  const dim = (text: string): string => sgr(['2'], text);
  return [
    ...WORDMARK.map(([gui = '', jam = '']) => `${sgr(['1'], gui)}${dim(jam)}`),
    '',
    TAGLINE,
    dim(`v${version}`),
  ];
}

export function highlighter(depth: ColorDepth): (text: string) => string {
  return depth === 'none' ? (text) => text : (text) => sgr(['36'], text);
}

export function renderBanner({ version, depth, columns }: BannerOptions): string {
  if (depth === 'none') return `GUIJam v${version}\n${TAGLINE}`;
  const logo = logoLines(depth);
  const text = textLines(version);
  const logoWidth = LOGO[0]?.length ?? 0;
  const textWidth = Math.max(TAGLINE.length, ...WORDMARK.map((row) => row.join('').length));
  if (columns < logoWidth + GAP + textWidth) {
    return [...logo.map((line) => line.trimEnd()), '', ...text].join('\n');
  }
  const offset = Math.floor((logo.length - text.length) / 2);
  return logo
    .map((line, row) => {
      const beside = text[row - offset];
      if (beside === undefined || beside === '') return line.trimEnd();
      return `${line}${' '.repeat(GAP)}${beside}`;
    })
    .join('\n');
}
