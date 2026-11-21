<script>
import Extras from '#lib/Extras.svelte';
import '../app.css';

let { children } = $props();
</script>

{@render children()}
<Extras />
