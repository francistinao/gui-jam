<template>
  <div class="flex items-center gap-4">
    <button type="button" class="rounded-lg bg-brand px-6 py-3 font-medium text-white" @click="count++">
      Order now
    </button>
    <span class="text-sm">Cups ordered: {{ count }}</span>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const count = ref(0);
</script>
