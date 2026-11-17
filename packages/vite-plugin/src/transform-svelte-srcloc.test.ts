import { parse } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';
import { injectSvelteSourceLocations, type SvelteCompiler } from './transform-svelte-srcloc.js';

const compiler = { parse } as unknown as SvelteCompiler;

function attributes(code: string): string[] {
  return [...code.matchAll(/<([\w:-]+)[^>]*?data-gj-src="([^"]+)"/g)].map(
    ([, tag, src]) => `${tag} ${src}`,
  );
}

describe('injectSvelteSourceLocations', () => {
  it('marks regular elements in blocks and snippets, not components or head tags', () => {
    const source = `<script>
  import OrderButton from '$lib/OrderButton.svelte';
  let { items = [], open = true } = $props();
</script>

<svelte:head><title>Brew</title></svelte:head>

<main class="px-12">
  <OrderButton />
  {#if open}<p>Open</p>{:else}<em>Closed</em>{/if}
  <ul>
    {#each items as item}<li>{item}</li>{/each}
  </ul>
  {#snippet row(text)}<span>{text}</span>{/snippet}
  {#await Promise.resolve(1)}<i>wait</i>{:then value}<b>{value}</b>{/await}
</main>

<style>
  main { color: red; }
</style>
`;

    const result = injectSvelteSourceLocations(
      source,
      '/repo/src/routes/+page.svelte',
      'src/routes/+page.svelte',
      compiler,
    );

    expect(attributes(result?.code ?? '')).toEqual([
      'main src/routes/+page.svelte:8:1',
      'p src/routes/+page.svelte:10:13',
      'em src/routes/+page.svelte:10:31',
      'ul src/routes/+page.svelte:11:3',
      'li src/routes/+page.svelte:12:26',
      'span src/routes/+page.svelte:14:23',
      'i src/routes/+page.svelte:15:30',
      'b src/routes/+page.svelte:15:54',
    ]);
    expect(result?.code).toContain('<title>Brew</title>');
    expect(result?.code).toContain('main { color: red; }');
  });

  it('counts columns in UTF-16 code units and leaves broken or marked files alone', () => {
    const korean = '<p>오늘 <span class="font-semibold">Ube</span></p>\n';
    expect(
      attributes(
        injectSvelteSourceLocations(korean, '/a.svelte', 'a.svelte', compiler)?.code ?? '',
      ),
    ).toEqual(['p a.svelte:1:1', 'span a.svelte:1:7']);
    expect(
      injectSvelteSourceLocations(
        '<p data-gj-src="x:1:1">Hi</p>',
        '/b.svelte',
        'b.svelte',
        compiler,
      ),
    ).toBeNull();
    expect(
      injectSvelteSourceLocations('{#if open}<p>never closed', '/c.svelte', 'c.svelte', compiler),
    ).toBeNull();
    expect(
      injectSvelteSourceLocations('<script>let a = 1;</script>', '/d.svelte', 'd.svelte', compiler),
    ).toBeNull();
  });
});
