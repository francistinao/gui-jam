import { useState } from 'react';
import { cn } from '../lib/cn';

export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <>
      <button
        type="button"
        className={cn('rounded-lg border border-espresso px-4 py-2', count > 0 && 'font-semibold')}
        onClick={() => setCount((value) => value + 1)}
      >
        Cups ordered: {count}
      </button>
      {count >= 3 && <span className="text-sm">Free pastry unlocked</span>}
    </>
  );
}
