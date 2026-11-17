import { Link } from 'react-router';

export default function Menu() {
  return (
    <div className="min-h-screen bg-crema px-12 py-6 font-sans text-espresso">
      <Link to="/" className="text-sm font-medium">
        Home
      </Link>
      <h1 className="mt-6 font-display text-4xl font-bold">Today's menu</h1>
      <p className="mt-4 rounded-card bg-latte p-4">Flat white, cortado and a slow pour-over.</p>
    </div>
  );
}
