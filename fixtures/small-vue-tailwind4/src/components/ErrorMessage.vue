<template>
  <p class="mt-1 text-sm text-red-700">{{ message }}</p>
</template>

<script setup lang="ts">
defineProps<{ message: string }>();
</script>
