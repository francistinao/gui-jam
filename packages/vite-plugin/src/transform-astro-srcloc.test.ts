import { parse } from '@astrojs/compiler-rs';
import { describe, expect, it } from 'vitest';
import { type AstroCompiler, injectAstroSourceLocations } from './transform-astro-srcloc.js';

const compiler = { parse } as unknown as AstroCompiler;

function attributes(code: string): string[] {
  return [...code.matchAll(/<([\w-]+)[^>]*?data-gj-src="([^"]+)"/g)].map(
    ([, tag, src]) => `${tag} ${src}`,
  );
}

describe('injectAstroSourceLocations', () => {
  it('marks html elements in the template, not components, head tags, scripts or styles', () => {
    const source = `---
import Layout from '../layouts/Layout.astro';
import { Tally } from '../components/Tally';
const items = ['Flat white', 'Cortado'];
---

<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Brew · Co.</title>
  </head>
  <body class="bg-crema">
    <Layout title="Menu · Brew">
      <main class="px-12">
        <ul>{items.map((item) => <li>{item}</li>)}</ul>
        <Tally client:load />
        <slot />
        <my-badge>New</my-badge>
        <p class:list={['a', { b: true }]} set:html={'<em>x</em>'}></p>
        <svg viewBox="0 0 1 1"><path d="M0 0" /></svg>
      </main>
    </Layout>
    <script>console.log('<div>not markup</div>');</script>
    <style>main { color: red; }</style>
  </body>
</html>
`;

    const result = injectAstroSourceLocations(
      source,
      '/repo/src/pages/menu.astro',
      'src/pages/menu.astro',
      compiler,
    );

    expect(attributes(result?.code ?? '')).toEqual([
      'body src/pages/menu.astro:12:3',
      'main src/pages/menu.astro:14:7',
      'ul src/pages/menu.astro:15:9',
      'li src/pages/menu.astro:15:34',
      'my-badge src/pages/menu.astro:18:9',
      'p src/pages/menu.astro:19:9',
      'svg src/pages/menu.astro:20:9',
      'path src/pages/menu.astro:20:32',
    ]);
    expect(result?.code).toContain("const items = ['Flat white', 'Cortado'];");
    expect(result?.code).toContain("<script>console.log('<div>not markup</div>');</script>");
    expect(result?.map.sources).toEqual(['/repo/src/pages/menu.astro']);
  });

  it('leaves files with no html elements, marked elements or parse failures alone', () => {
    const throwing = {
      parse: () => {
        throw new Error('bad');
      },
    } as AstroCompiler;

    expect(injectAstroSourceLocations('<Layout />', '/r/a.astro', 'a.astro', compiler)).toBeNull();
    expect(
      injectAstroSourceLocations(
        '<p data-gj-src="a.astro:1:1">x</p>',
        '/r/a.astro',
        'a.astro',
        compiler,
      ),
    ).toBeNull();
    expect(injectAstroSourceLocations('<p>x</p>', '/r/a.astro', 'a.astro', throwing)).toBeNull();
  });
});
