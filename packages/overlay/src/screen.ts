import { useSyncExternalStore } from 'react';
import type { Screen } from './model';

const DARK = '(prefers-color-scheme: dark)';
let last: Screen | null = null;

export function currentScreen(): Screen {
  const next = {
    width: window.innerWidth,
    dark: window.matchMedia(DARK).matches || document.documentElement.classList.contains('dark'),
  };
  if (last && last.width === next.width && last.dark === next.dark) return last;
  last = next;
  return next;
}

function subscribe(change: () => void): () => void {
  const dark = window.matchMedia(DARK);
  window.addEventListener('resize', change);
  dark.addEventListener('change', change);
  return () => {
    window.removeEventListener('resize', change);
    dark.removeEventListener('change', change);
  };
}

export function useScreen(): Screen {
  return useSyncExternalStore(subscribe, currentScreen);
}
