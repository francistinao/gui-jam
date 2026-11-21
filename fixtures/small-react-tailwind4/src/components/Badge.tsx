import type { ReactNode } from 'react';

export function Badge({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-brand px-3 py-1 text-sm text-white">{children}</span>;
}
