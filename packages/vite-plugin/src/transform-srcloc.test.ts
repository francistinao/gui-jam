import { describe, expect, it } from 'vitest';
import { injectSourceLocations, locate } from './transform-srcloc.js';

const annotate = (code: string, path = 'src/App.tsx') =>
  injectSourceLocations(code, `/project/${path}`, path)?.code;

describe('injectSourceLocations', () => {
  it('annotates intrinsic elements with their 1-based line and column', () => {
    const code = [
      'export function App() {',
      '  return (',
      '    <main>',
      '      <h1 className="title">Hi</h1>',
      '    </main>',
      '  );',
      '}',
    ].join('\n');

    expect(annotate(code)).toBe(
      [
        'export function App() {',
        '  return (',
        '    <main data-gj-src="src/App.tsx:3:5">',
        '      <h1 data-gj-src="src/App.tsx:4:7" className="title">Hi</h1>',
        '    </main>',
        '  );',
        '}',
      ].join('\n'),
    );
  });

  it('leaves components, member expressions and namespaced names alone', () => {
    const code =
      'const a = <Card><motion.div /><svg:rect /><Icons.Cup /></Card>;\nconst b = <b>x</b>;';

    expect(annotate(code)).toBe(
      'const a = <Card><motion.div /><svg:rect /><Icons.Cup /></Card>;\nconst b = <b data-gj-src="src/App.tsx:2:11">x</b>;',
    );
  });

  it('counts columns in UTF-16 code units after Korean text on the same line', () => {
    const code = 'const p = <p>오늘의 추천 <span>Latte</span></p>;';

    expect(annotate(code)).toBe(
      'const p = <p data-gj-src="src/App.tsx:1:11">오늘의 추천 <span data-gj-src="src/App.tsx:1:21">Latte</span></p>;',
    );
  });

  it('annotates elements with spread props and skips fragments', () => {
    const code = 'const x = <><article {...rest} id="a" /></>;';

    expect(annotate(code)).toBe(
      'const x = <><article data-gj-src="src/App.tsx:1:13" {...rest} id="a" /></>;',
    );
  });

  it('does not annotate an element twice', () => {
    const code = 'const x = <i data-gj-src="src/App.tsx:1:11" />;';

    expect(annotate(code)).toBeUndefined();
  });

  it('escapes quotes in the project path', () => {
    expect(annotate('const x = <i />;', 'src/a"b.tsx')).toBe(
      'const x = <i data-gj-src="src/a&quot;b.tsx:1:11" />;',
    );
  });

  it('returns null for code that does not parse', () => {
    expect(annotate('const x = <div>;')).toBeUndefined();
  });

  it('returns null when there is no intrinsic element', () => {
    expect(annotate('export const total = 1 + 2;')).toBeUndefined();
  });
});

describe('locate', () => {
  it('maps offsets on CRLF files to the line after each newline', () => {
    const starts = [0, 6, 12];

    expect(locate(starts, 0)).toEqual({ line: 1, column: 1 });
    expect(locate(starts, 5)).toEqual({ line: 1, column: 6 });
    expect(locate(starts, 6)).toEqual({ line: 2, column: 1 });
    expect(locate(starts, 13)).toEqual({ line: 3, column: 2 });
  });
});
