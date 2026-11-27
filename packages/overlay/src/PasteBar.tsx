import type { Controller, WidgetState } from './controller';
import { Button } from './figui/button';
import { copiedGroups, GROUP_LABELS } from './model';
import { type Store, useStore } from './store';

export function PasteBar({
  store,
  controller,
}: {
  store: Store<WidgetState>;
  controller: Controller;
}) {
  const copied = useStore(store, (state) => state.copied);
  const pasting = useStore(store, (state) => state.pasting);
  if (!copied || !pasting) return null;
  const file = copied.file.split('/').at(-1) ?? copied.file;
  return (
    <section
      aria-label="Paste style"
      data-interactive=""
      className="typography-body-medium fixed bottom-32 left-1/2 flex w-max max-w-[480px] -translate-x-1/2 flex-col gap-2 rounded-lg bg-white-1000 p-3 text-black-800 shadow-500 ring-1 ring-black-100"
    >
      <div className="flex items-center gap-3">
        <span className="mr-auto">
          Pasting style from <code>{copied.tag}</code> in {file}
        </span>
        <Button variant="secondary" onClick={controller.stopPasting}>
          Stop
        </Button>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {copiedGroups(copied.values).map((group) => (
          <label key={group} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={pasting.includes(group)}
              onChange={() => controller.toggleCopied(group)}
            />
            {GROUP_LABELS[group]}
          </label>
        ))}
      </div>
      <p className="typography-body-small text-grey-500">Click an element to paste · Esc to stop</p>
    </section>
  );
}
