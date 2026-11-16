import { Counter } from './components/Counter';
import { MenuCard } from './components/MenuCard';
import { OrderButton } from './components/OrderButton';

const MENU = [
  {
    name: 'Spanish Latte',
    description: 'Espresso, milk and a touch of condensed milk',
    price: 160,
  },
  { name: 'Ube Cheese Pandesal', description: 'Soft roll topped with ube cream', price: 85 },
  { name: 'Ensaymada', description: 'Buttery brioche with queso and sugar', price: 95 },
] as const;

export function App() {
  return (
    <div className="min-h-screen bg-crema font-sans text-espresso">
      <header className="flex items-center justify-between px-12 py-6">
        <span className="flex items-center gap-2 font-display text-2xl font-bold">
          <img src="/cup.svg" alt="Coffee cup" className="size-7" />
          Brew &amp; Co.
        </span>
        <nav className="flex gap-8">
          <a href="#menu">Menu</a>
          <a href="#branches">Branches</a>
          <a href="#rewards">Rewards</a>
        </nav>
      </header>
      <main className="px-12">
        <section className="py-12">
          <h1 className="font-display text-5xl font-bold">Slow-roasted, made for mornings</h1>
          <p className="mt-4 text-lg">Order ahead and pick up at your nearest branch.</p>
          <p className="mt-2">
            오늘의 추천 <span className="font-semibold text-brand">Ube Latte</span>
          </p>
          <div className="mt-6 flex items-center gap-6">
            <OrderButton />
            <Counter />
          </div>
        </section>
        <section id="menu" className="pb-12">
          <h2 className="text-xl font-semibold">Today’s menu</h2>
          <div className="mt-4 grid grid-cols-3 gap-6">
            {MENU.map((item) => (
              <MenuCard key={item.name} {...item} />
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
