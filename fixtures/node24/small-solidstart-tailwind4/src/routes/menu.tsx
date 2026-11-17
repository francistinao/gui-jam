import { A } from '@solidjs/router';

export default function Menu() {
  return (
    <div class="min-h-screen bg-crema px-12 py-6 font-sans text-espresso">
      <A href="/" class="text-sm font-medium">
        Home
      </A>
      <h1 class="mt-6 font-display text-4xl font-bold">Today's menu</h1>
      <p class="mt-4 rounded-card bg-latte p-4">Flat white, cortado and a slow pour-over.</p>
    </div>
  );
}
