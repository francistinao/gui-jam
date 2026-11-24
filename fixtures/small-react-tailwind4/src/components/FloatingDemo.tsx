import { Dialog, DropdownMenu, Popover, Tooltip } from 'radix-ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';

const TRIGGER = 'rounded-md bg-espresso px-3 py-2 text-sm text-white';
const SURFACE = 'rounded-lg bg-white p-4 text-espresso shadow-lg ring-1 ring-black/10';

function RadixDialog() {
  return (
    <Dialog.Root>
      <Dialog.Trigger className={TRIGGER}>Open Radix dialog</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          className={`fixed top-1/2 left-1/2 w-96 -translate-x-1/2 -translate-y-1/2 ${SURFACE}`}
        >
          <Dialog.Title className="text-lg font-semibold">Radix dialog</Dialog.Title>
          <Dialog.Description>Choose how you want your order.</Dialog.Description>
          <p className="mt-3 rounded bg-crema px-3 py-2">Radix dialog body</p>
          <input aria-label="Dialog note" className="mt-3 w-full rounded border px-2 py-1" />
          <Dialog.Close className={`mt-4 ${TRIGGER}`}>Close dialog</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function RadixPopover() {
  return (
    <Popover.Root>
      <Popover.Trigger className={TRIGGER}>Open Radix popover</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={8} className={SURFACE}>
          <p className="w-56">Radix popover body</p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function RadixMenu() {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className={TRIGGER}>Open Radix menu</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content sideOffset={8} className={`w-48 ${SURFACE}`}>
          <DropdownMenu.Item className="rounded px-2 py-1">
            <span>Radix menu item</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className="rounded px-2 py-1">
            <span>Another item</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function RadixTooltip() {
  return (
    <Tooltip.Provider delayDuration={0}>
      <Tooltip.Root>
        <Tooltip.Trigger className={TRIGGER}>Radix tooltip trigger</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content sideOffset={6} className="rounded bg-espresso px-3 py-2 text-white">
            <span>Radix tooltip text</span>
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

function NativeDialog() {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button type="button" className={TRIGGER} onClick={() => dialog.current?.showModal()}>
        Open native dialog
      </button>
      <dialog
        ref={dialog}
        aria-label="Native dialog"
        className={`m-auto w-96 ${SURFACE} backdrop:bg-black/40`}
      >
        <p className="rounded bg-crema px-3 py-2">Native dialog body</p>
        <input aria-label="Native note" className="mt-3 w-full rounded border px-2 py-1" />
        <button type="button" className={`mt-4 ${TRIGGER}`} onClick={() => dialog.current?.close()}>
          Close native dialog
        </button>
      </dialog>
    </>
  );
}

function NativePopover() {
  return (
    <>
      <button type="button" className={TRIGGER} popoverTarget="native-popover">
        Open native popover
      </button>
      <div id="native-popover" popover="auto" className={SURFACE}>
        <p className="w-56">Native popover body</p>
      </div>
    </>
  );
}

function OutsidePress({ label, scope }: { label: string; scope: 'document' | 'window' }) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const target = scope === 'window' ? window : document;
    const type = scope === 'window' ? 'mousedown' : 'pointerdown';
    const close = (event: Event) => {
      if (!(event.target instanceof Node && panel.current?.contains(event.target))) setOpen(false);
    };
    target.addEventListener(type, close, true);
    return () => target.removeEventListener(type, close, true);
  }, [open, scope]);
  return (
    <div className="relative">
      <button type="button" className={TRIGGER} onClick={() => setOpen(true)}>
        {`Open ${label}`}
      </button>
      {open ? (
        <div
          ref={panel}
          role="dialog"
          aria-label={label}
          className={`absolute top-12 z-10 ${SURFACE}`}
        >
          <p className="w-56">{`${label} body`}</p>
        </div>
      ) : null}
    </div>
  );
}

function FocusTrap({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = box.current;
    if (!open || !node) return;
    const field = node.querySelector('input');
    field?.focus();
    const inside = (event: Event) => event.target instanceof Node && node.contains(event.target);
    const keepFocus = (event: FocusEvent) => {
      if (!inside(event)) field?.focus();
    };
    const blockClick = (event: MouseEvent) => {
      if (inside(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('focusin', keepFocus, true);
    document.addEventListener('click', blockClick, true);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('focusin', keepFocus, true);
      document.removeEventListener('click', blockClick, true);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [open]);
  return (
    <>
      <button type="button" className={TRIGGER} onClick={() => setOpen(true)}>
        Open focus trap
      </button>
      {open ? (
        <div
          ref={box}
          role="dialog"
          aria-label="Focus trap"
          className={`fixed top-24 left-1/2 w-80 ${SURFACE}`}
        >
          {children}
          <input aria-label="Trap note" className="mt-3 w-full rounded border px-2 py-1" />
        </div>
      ) : null}
    </>
  );
}

function Hotkey() {
  const [presses, setPresses] = useState(0);
  useEffect(() => {
    const count = (event: KeyboardEvent) => {
      if (event.key === '/') setPresses((value) => value + 1);
    };
    document.addEventListener('keydown', count);
    return () => document.removeEventListener('keydown', count);
  }, []);
  return <output aria-label="Hotkey presses">{presses}</output>;
}

export function FloatingDemo() {
  return (
    <section aria-label="Floating demo" className="flex flex-wrap items-start gap-4 pb-12">
      <RadixDialog />
      <RadixPopover />
      <RadixMenu />
      <RadixTooltip />
      <NativeDialog />
      <NativePopover />
      <OutsidePress label="Capture popover" scope="document" />
      <OutsidePress label="Window popover" scope="window" />
      <FocusTrap>
        <p className="rounded bg-crema px-3 py-2">Focus trap body</p>
      </FocusTrap>
      <Hotkey />
    </section>
  );
}
