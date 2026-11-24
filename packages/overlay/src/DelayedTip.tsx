import type { ReactNode } from 'react';

interface DelayedTipProps {
  text: string;
  children: ReactNode;
}

export function DelayedTip({ text, children }: DelayedTipProps) {
  return (
    <span data-tip-host="" className="relative flex">
      {children}
      <span aria-hidden="true" data-tip="" className="guijam-tip">
        {text}
      </span>
    </span>
  );
}
