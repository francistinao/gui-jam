import { useState } from 'react';
import en from '../i18n/en.json';
import { Badge } from './Badge';
import { Note } from './Note';

const TABS = [
  { id: 'overview', title: 'CBPLD Overview' },
  { id: 'reports', title: 'Monthly Reports' },
];

const PLAN = { name: 'Barista Club' };
const UPSELL = { name: 'Barista Club' };

function t(key: string): string {
  const found = key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        typeof node === 'object' && node !== null
          ? (node as Record<string, unknown>)[part]
          : undefined,
      en,
    );
  return typeof found === 'string' ? found : key;
}

function peso(amount: number): string {
  return `₱${amount}`;
}

export function Extras() {
  const [activeId] = useState('overview');
  const activeTab = TABS.find((tab) => tab.id === activeId);
  return (
    <section id="extras" className="flex flex-col items-start gap-3 px-12 pb-40">
      <h4 className="text-xl font-semibold">{activeTab?.title}</h4>
      <Badge>Fresh today</Badge>
      <Note title="Open daily" />
      <p className="text-sm">{t('footer.hours')}</p>
      <p className="text-sm">{PLAN.name}</p>
      <p className="text-sm">{UPSELL.name}</p>
      <p className="text-sm">{peso(250)}</p>
    </section>
  );
}
