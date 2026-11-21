import { PLANS } from './plans';

export function App() {
  return (
    <div className="min-h-screen bg-crema font-sans text-espresso">
      <header className="flex items-center justify-between px-12 py-6">
        <span className="font-display text-2xl font-bold">Brew &amp; Co.</span>
        <a href="#plans" className="text-sm font-medium">
          Plans
        </a>
      </header>
      <main className="px-12 pb-16">
        <section className="py-12">
          <h1 className="font-display text-5xl font-bold">Coffee delivered weekly</h1>
          <p className="mt-4 max-w-xl text-lg">
            Pick a plan, pause anytime, and get beans roasted the morning they ship.
          </p>
          <button
            type="button"
            className="mt-6 rounded-md bg-brand px-6 py-3 font-semibold text-white"
          >
            Subscribe
          </button>
        </section>
        <section id="plans" className="grid grid-cols-3 gap-6">
          {PLANS.map((plan) => (
            <article key={plan.id} className="rounded-card bg-white p-6 shadow-sm">
              <h2 className="text-lg font-semibold">{plan.name}</h2>
              <p className="mt-2 text-sm">{plan.blurb}</p>
              <p className="mt-4 text-2xl font-bold">{plan.price}</p>
            </article>
          ))}
        </section>
      </main>
    </div>
  );
}
