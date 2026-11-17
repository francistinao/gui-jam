<script>
let count = $state(0);
</script>

<div class="flex items-center gap-4">
  <button type="button" class="rounded-lg bg-brand px-6 py-3 font-medium text-white" onclick={() => count++}>
    Order now
  </button>
  <span class="text-sm">Cups ordered: {count}</span>
</div>
