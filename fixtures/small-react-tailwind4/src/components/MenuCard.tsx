import type { ComponentProps } from 'react';

interface MenuCardProps extends ComponentProps<'article'> {
  name: string;
  description: string;
  price: number;
}

export function MenuCard({ name, description, price, ...articleProps }: MenuCardProps) {
  return (
    <article {...articleProps} className="flex flex-col gap-3 rounded-card bg-white p-6 shadow-sm">
      <h3 className="text-lg font-semibold">{name}</h3>
      <p className="text-sm">{description}</p>
      <div className="mt-auto flex items-center justify-between">
        <span className="font-semibold">₱{price}</span>
        <button type="button" className="rounded-full bg-espresso px-4 py-1.5 text-sm text-white">
          Add
        </button>
      </div>
    </article>
  );
}
