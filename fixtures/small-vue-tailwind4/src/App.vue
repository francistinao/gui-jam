<template>
  <div class="min-h-screen bg-crema font-sans text-espresso">
    <header class="flex items-center justify-between px-12 py-6">
      <span class="flex items-center gap-2 font-display text-2xl font-bold">
        <img src="/cup.svg" alt="Coffee cup" class="size-7" />
        Brew &amp; Co.
      </span>
      <nav class="flex gap-8">
        <a v-for="link in links" :key="link" :href="`#${link.toLowerCase()}`">{{ link }}</a>
      </nav>
    </header>
    <main class="px-12">
      <section class="py-12">
        <h1 class="font-display text-5xl font-bold">Slow-roasted, made for mornings</h1>
        <p class="mt-4 text-lg">Order ahead and pick up at your nearest branch.</p>
        <div class="mt-6">
          <OrderButton />
        </div>
        <p v-if="open" class="mt-6" style="background-color: #fde68a; border-radius: 8px; padding: 16px">
          Gift cards for every occasion
        </p>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import OrderButton from './components/OrderButton.vue';

const links = ['Menu', 'Branches', 'Rewards'];
const open = true;
</script>
