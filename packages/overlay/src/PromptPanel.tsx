import type { Controller, WidgetState } from './controller';
import { Button } from './figui/button';
import { cn } from './figui/cn';
import { INPUT_BASE_CLASS } from './figui/text-input';
import { CodeChanges, Popover, PopoverHeader } from './Popover';
import { type Store, useStore } from './store';

interface PanelProps {
  store: Store<WidgetState>;
  controller: Controller;
}

/** Ask AI: describe a change, preview one variant in the page, then Use or Discard it. */
export function PromptPanel({ store, controller }: PanelProps) {
  const selection = useStore(store, (state) => state.selection);
  const anchor = useStore(store, (state) => state.anchor);
  const style = useStore(store, (state) => state.style);
  const generation = useStore(store, (state) => state.generation);
  const busy = useStore(store, (state) => state.busy);

  if (!selection || !anchor) return null;
  const { prompt, status, variant } = generation;

  return (
    <Popover label={`Ask AI ${selection.file}`} anchor={anchor}>
      <PopoverHeader
        tag={style?.tag}
        badge="Ask AI"
        selection={selection}
        controller={controller}
      />
      {selection.instances > 1 ? (
        <p
          role="note"
          className="typography-body-small mb-2 rounded-md bg-blue-100 p-2 text-blue-800"
        >
          {`Used ${selection.instances}× on this page — changes apply to every instance.`}
        </p>
      ) : null}
      {variant ? (
        <section aria-label="Variant" className="flex flex-col gap-1">
          <h3 className="typography-body-medium font-[600]">{variant.label}</h3>
          <p className="typography-body-small text-grey-600">{variant.rationale}</p>
          <CodeChanges changes={variant.changes} />
          <footer className="flex items-center justify-end gap-2 pt-1">
            <span className="typography-body-small mr-auto text-grey-500">
              {`Previewed · ${(variant.elapsedMs / 1000).toFixed(1)} s`}
            </span>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void controller.discardVariant()}
            >
              Discard
            </Button>
            <Button disabled={busy} onClick={() => void controller.applyVariant()}>
              Use
            </Button>
          </footer>
        </section>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void controller.generate();
          }}
        >
          <textarea
            aria-label="Describe the change"
            placeholder="Make it pill-shaped and darker"
            rows={3}
            value={prompt}
            disabled={status === 'running'}
            className={cn(INPUT_BASE_CLASS, 'h-auto resize-none py-1.5')}
            onChange={(event) => controller.setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <footer className="flex items-center justify-end gap-2">
            {status === 'running' ? (
              <>
                <span role="status" className="typography-body-small mr-auto text-grey-500">
                  Generating…
                </span>
                <Button variant="secondary" onClick={() => void controller.cancelGeneration()}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button type="submit" disabled={prompt.trim() === ''}>
                Generate
              </Button>
            )}
          </footer>
        </form>
      )}
    </Popover>
  );
}
