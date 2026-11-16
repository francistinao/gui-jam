import { useState } from 'react';

export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button
      type="button"
      className="rounded-lg border border-espresso px-4 py-2"
      onClick={() => setCount((value) => value + 1)}
    >
      Cups ordered: {count}
    </button>
  );
}
