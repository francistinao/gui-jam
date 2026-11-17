import { OrderButton } from './components/OrderButton';

export function App() {
  return (
    <div class="min-h-screen bg-crema font-sans text-espresso">
      <header class="flex items-center justify-between px-12 py-6">
        <span class="flex items-center gap-2 font-display text-2xl font-bold">
          <img src="/cup.svg" alt="Coffee cup" class="size-7" />
          Brew &amp; Co.
        </span>
      </header>
      <main class="px-12">
        <section class="py-12">
          <h1 class="font-display text-5xl font-bold">Slow-roasted, made for mornings</h1>
          <div class="mt-6">
            <OrderButton />
          </div>
          <p
            class="mt-6"
            style={{ 'background-color': '#fde68a', 'border-radius': '8px', padding: '16px' }}
          >
            Gift cards for every occasion
          </p>
        </section>
      </main>
    </div>
  );
}
