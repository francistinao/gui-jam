import type { CodeChange } from '@guijam/contracts-ts';
import { type ReactNode, useCallback, useState } from 'react';
import type { Controller, Selection } from './controller';
import { Button } from './figui/button';
import { placePopover, type Rect } from './model';

const POPOVER_WIDTH = 300;

interface PopoverProps {
  label: string;
  anchor: Rect;
  children: ReactNode;
}

export function Popover({ label, anchor, children }: PopoverProps) {
  const [height, setHeight] = useState(360);
  const measure = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const placement = placePopover(
    anchor,
    { width: POPOVER_WIDTH, height },
    { width: window.innerWidth, height: window.innerHeight },
  );
  return (
    <div
      ref={measure}
      role="dialog"
      aria-label={label}
      data-interactive=""
      className="fixed flex flex-col rounded-[13px] bg-white-1000 p-3 text-black-800 shadow-500 ring-1 ring-black-100"
      style={{ left: placement.left, top: placement.top, width: POPOVER_WIDTH }}
    >
      {children}
    </div>
  );
}

interface PopoverHeaderProps {
  tag: string | undefined;
  badge: string;
  selection: Selection;
  controller: Controller;
  children?: ReactNode;
}

export function PopoverHeader({ tag, badge, selection, controller, children }: PopoverHeaderProps) {
  return (
    <header className="flex items-start justify-between gap-2 pb-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="typography-body-medium font-[600]">{tag ?? '…'}</span>
          <span className="typography-body-small rounded-sm bg-green-100 px-1 text-green-700">
            {badge}
          </span>
        </div>
        <code className="typography-body-small block truncate text-grey-500">
          {`${selection.file}:${selection.line}`}
        </code>
      </div>
      <div className="flex items-center gap-1">
        {children}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close"
          onClick={() => void controller.close()}
        >
          ×
        </Button>
      </div>
    </header>
  );
}

function numbered(first: number, sign: string, lines: readonly string[]): string {
  return lines.map((line, index) => `${first + index} ${sign} ${line.trim()}`).join('\n');
}

export function CodeChanges({ changes }: { changes: readonly CodeChange[] }) {
  if (changes.length === 0) {
    return <p className="typography-body-medium py-3 text-grey-500">No changes yet.</p>;
  }
  return (
    <div className="flex flex-col gap-2 py-2">
      {changes.map((change) => (
        <pre
          key={`${change.file}:${change.line}`}
          className="typography-body-small rounded-md bg-grey-100 p-2 font-mono break-all whitespace-pre-wrap"
        >
          <span className="block text-red-600">{numbered(change.line, '−', change.before)}</span>
          <span className="block text-green-600">{numbered(change.line, '+', change.after)}</span>
        </pre>
      ))}
    </div>
  );
}
