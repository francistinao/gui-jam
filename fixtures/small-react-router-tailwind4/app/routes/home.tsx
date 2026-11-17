import { Link } from 'react-router';
import { OrderButton } from '../components/OrderButton';

export function meta() {
  return [{ title: 'Brew & Co.' }];
}

export default function Home() {
  return (
    <div className="min-h-screen bg-crema font-sans text-espresso">
      <header className="flex items-center justify-between px-12 py-6">
        <span className="flex items-center gap-2 font-display text-2xl font-bold">
          <img src="/cup.svg" alt="Coffee cup" className="size-7" />
          Brew &amp; Co.
        </span>
        <Link to="/menu" className="text-sm font-medium">
          Menu
        </Link>
      </header>
      <main className="px-12">
        <section className="py-12">
          <h1 className="font-display text-5xl font-bold">Slow-roasted, made for mornings</h1>
          <div className="mt-6">
            <OrderButton />
          </div>
          <p className="mt-6" style={{ backgroundColor: '#fde68a', borderRadius: 8, padding: 16 }}>
            Gift cards for every occasion
          </p>
        </section>
      </main>
    </div>
  );
}
