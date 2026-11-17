import { useState } from 'react';

export function Tally() {
  const [cups, setCups] = useState(0);
  return (
    <button
      type="button"
      className="rounded-lg bg-espresso px-4 py-2 text-sm text-white"
      onClick={() => setCups(cups + 1)}
    >
      Cups today: {cups}
    </button>
  );
}
