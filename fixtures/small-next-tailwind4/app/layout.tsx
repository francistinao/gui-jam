import type { ReactNode } from 'react';
import { Extras } from './components/Extras';
import './globals.css';

export const metadata = { title: 'Brew & Co.' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-crema font-sans text-espresso">
        {children}
        <Extras />
      </body>
    </html>
  );
}
