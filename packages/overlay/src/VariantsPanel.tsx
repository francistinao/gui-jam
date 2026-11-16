import type { Controller, Generation } from './controller';
import { Button } from './figui/button';
import { cn } from './figui/cn';
import { droppedNote } from './model';
import { CodeChanges } from './Popover';

interface VariantsPanelProps {
  generation: Generation;
  busy: boolean;
  controller: Controller;
}

export function VariantsPanel({ generation, busy, controller }: VariantsPanelProps) {
  const { variants, active, dropped, route, elapsedMs } = generation;
  const variant = variants[active];
  if (!variant) return null;
  const note = droppedNote(dropped);
  const meta = [`${(elapsedMs / 1000).toFixed(1)} s`, route?.model].filter(Boolean).join(' · ');

  return (
    <section aria-label="Variants" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h3 className="typography-body-medium-strong">Variants</h3>
        <span className="typography-body-small text-grey-500">Live on your page</span>
      </div>
      <fieldset aria-label="Pick a variant" className="m-0 grid grid-cols-3 gap-2 border-0 p-0">
        {variants.map((option, index) => (
          <button
            key={option.changesetId}
            type="button"
            aria-pressed={index === active}
            aria-label={`V${index + 1} · ${option.style}`}
            disabled={busy}
            onClick={() => void controller.selectVariant(index)}
            className={cn(
              'flex h-14 flex-col items-center justify-center gap-0.5 rounded-md border bg-grey-100 px-1',
              index === active
                ? 'border-blue-500 inset-ring inset-ring-blue-500'
                : 'border-grey-200 hover:bg-grey-200',
            )}
          >
            <span className="typography-body-medium-strong">{`V${index + 1}`}</span>
            <span className="typography-body-small w-full truncate text-grey-600">
              {option.style}
            </span>
          </button>
        ))}
      </fieldset>
      {route?.notice ? (
        <p role="note" className="typography-body-small rounded-md bg-blue-100 p-2 text-blue-800">
          {route.notice}
        </p>
      ) : null}
      {note ? (
        <p role="note" className="typography-body-small rounded-md bg-grey-100 p-2 text-grey-700">
          {note}
        </p>
      ) : null}
      <dl className="typography-body-small grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <dt className="text-grey-500">System</dt>
        <dd>{variant.system}</dd>
        <dt className="text-grey-500">Style</dt>
        <dd>{variant.style}</dd>
        <dt className="text-grey-500">File</dt>
        <dd className="truncate font-mono">{variant.file.split('/').pop()}</dd>
      </dl>
      <p className="typography-body-small text-grey-600">
        <span className="font-[600] text-grey-800">{variant.label}.</span> {variant.rationale}
      </p>
      <CodeChanges changes={variant.changes} />
      <p className="typography-body-small text-grey-500">{meta}</p>
      <footer className="flex items-center justify-end gap-2">
        <Button variant="secondary" disabled={busy} onClick={() => void controller.close()}>
          Discard
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => void controller.editPrompt()}>
          Edit prompt
        </Button>
        <Button disabled={busy} onClick={() => void controller.commitVariant()}>
          {`Use V${active + 1}`}
        </Button>
      </footer>
    </section>
  );
}
