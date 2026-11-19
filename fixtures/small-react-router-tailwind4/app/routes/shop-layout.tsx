import { Outlet } from 'react-router';

export default function ShopLayout() {
  return (
    <div className="flex min-h-screen bg-crema font-sans text-espresso">
      <aside className="w-48 bg-latte p-6">Shop</aside>
      <main className="min-h-screen flex-1 px-12 py-6">
        <Outlet />
      </main>
    </div>
  );
}
