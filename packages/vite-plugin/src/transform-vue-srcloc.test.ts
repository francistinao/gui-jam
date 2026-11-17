import { describe, expect, it } from 'vitest';
import { parse } from 'vue/compiler-sfc';
import { injectVueSourceLocations, type VueSfcCompiler } from './transform-vue-srcloc.js';

const compiler = { parse } as unknown as VueSfcCompiler;

function attributes(code: string): string[] {
  return [...code.matchAll(/<([\w-]+)[^>]*?data-gj-src="([^"]+)"/g)].map(
    ([, tag, src]) => `${tag} ${src}`,
  );
}

describe('injectVueSourceLocations', () => {
  it('marks library and auto-imported components so their root element points at the usage', () => {
    const source = `<template>
  <VCard class="pa-4">
    <VBtn color="primary" type="submit">Log in</VBtn>
    <v-text-field label="Email" />
    <AppTextField label="Name" />
    <OrderButton />
    <order-button />
    <LocalCard />
    <component :is="tag" />
    <Transition><p>Hi</p></Transition>
    <RouterView />
    <router-view />
  </VCard>
</template>

<script setup lang="ts">
import OrderButton from './components/OrderButton.vue';
import LocalCard, { helper } from '@/components/LocalCard.vue';
import { VBtn } from 'vuetify/components';
</script>
`;

    const result = injectVueSourceLocations(
      source,
      '/repo/src/Login.vue',
      'src/Login.vue',
      compiler,
    );

    expect(attributes(result?.code ?? '')).toEqual([
      'VCard src/Login.vue:2:3',
      'VBtn src/Login.vue:3:5',
      'v-text-field src/Login.vue:4:5',
      'AppTextField src/Login.vue:5:5',
      'p src/Login.vue:10:17',
    ]);
  });

  it('marks native elements with their own line and column, skipping local components and templates', () => {
    const source = `<template>
  <div class="card">
    <OrderButton />
    <order-button />
    <template v-if="open"><p>Open</p></template>
    <ul>
      <li v-for="item in items" :key="item">{{ item }}</li>
    </ul>
    <slot />
    <img src="/cup.svg" alt="Cup" />
  </div>
</template>

<script setup lang="ts">
import OrderButton from './OrderButton.vue';
const items = ['a'];
const open = true;
</script>
`;

    const result = injectVueSourceLocations(source, '/repo/src/App.vue', 'src/App.vue', compiler);

    expect(attributes(result?.code ?? '')).toEqual([
      'div src/App.vue:2:3',
      'p src/App.vue:5:27',
      'ul src/App.vue:6:5',
      'li src/App.vue:7:7',
      'img src/App.vue:10:5',
    ]);
    expect(result?.code).toContain(
      '<script setup lang="ts">\nimport OrderButton from \'./OrderButton.vue\';\nconst items',
    );
    expect(result?.map.mappings.length).toBeGreaterThan(0);
  });

  it('counts columns in UTF-16 code units after non-ASCII text', () => {
    const source =
      '<template>\n  <p>오늘 <span class="font-semibold">Ube</span></p>\n</template>\n';
    const result = injectVueSourceLocations(source, '/repo/src/A.vue', 'src/A.vue', compiler);
    expect(attributes(result?.code ?? '')).toEqual(['p src/A.vue:2:3', 'span src/A.vue:2:9']);
  });

  it('leaves files without a template, already marked elements, or parse errors alone', () => {
    expect(
      injectVueSourceLocations(
        '<script setup>const a = 1;</script>\n',
        '/repo/src/B.vue',
        'src/B.vue',
        compiler,
      ),
    ).toBeNull();
    expect(
      injectVueSourceLocations(
        '<template><p data-gj-src="x:1:1">Hi</p></template>\n',
        '/repo/src/C.vue',
        'src/C.vue',
        compiler,
      ),
    ).toBeNull();
    expect(
      injectVueSourceLocations(
        '<template><div><p></template>\n',
        '/repo/src/D.vue',
        'src/D.vue',
        compiler,
      ),
    ).toBeNull();
  });
});
