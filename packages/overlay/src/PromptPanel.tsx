import type { Controller, ProgressStep, WidgetState } from './controller';
import { Button } from './figui/button';
import { cn } from './figui/cn';
import { INPUT_BASE_CLASS } from './figui/text-input';
import { Popover, PopoverHeader } from './Popover';
import { type Store, useStore } from './store';
import { VariantsPanel } from './VariantsPanel';

interface PanelProps {
  store: Store<WidgetState>;
  controller: Controller;
}

function StepIcon({ state }: { state: ProgressStep['state'] }) {
  if (state === 'done') {
    return (
      <svg viewBox="0 0 16 16" className="size-4 flex-none text-green-600" aria-hidden="true">
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path d="M4.8 8.2l2.1 2.1 4.3-4.6" fill="none" stroke="white" strokeWidth="1.6" />
      </svg>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        'size-4 flex-none rounded-full border-2',
        state === 'active'
          ? 'animate-spin border-blue-500 border-t-transparent'
          : 'border-grey-300',
      )}
    />
  );
}

function Progress({ steps }: { steps: readonly ProgressStep[] }) {
  return (
    <ol aria-label="Progress" className="flex flex-col gap-1.5">
      {steps.map((step) => (
        <li
          key={step.label}
          data-state={step.state}
          className={cn(
            'typography-body-small flex items-center gap-2',
            step.state === 'pending' ? 'text-grey-400' : 'text-grey-800',
          )}
        >
          <StepIcon state={step.state} />
          {step.label}
        </li>
      ))}
    </ol>
  );
}

export function PromptPanel({ store, controller }: PanelProps) {
  const selection = useStore(store, (state) => state.selection);
  const anchor = useStore(store, (state) => state.anchor);
  const style = useStore(store, (state) => state.style);
  const generation = useStore(store, (state) => state.generation);
  const busy = useStore(store, (state) => state.busy);

  if (!selection || !anchor) return null;
  const { prompt, status, steps, error } = generation;
  const badge = status === 'ready' ? 'Variants' : status === 'running' ? 'Generating' : 'Ask AI';

  return (
    <Popover label={`Ask AI ${selection.file}`} anchor={anchor}>
      <PopoverHeader tag={style?.tag} badge={badge} selection={selection} controller={controller} />
      {selection.instances > 1 ? (
        <p
          role="note"
          className="typography-body-small mb-2 rounded-md bg-blue-100 p-2 text-blue-800"
        >
          {`Used ${selection.instances}× on this page — changes apply to every instance.`}
        </p>
      ) : null}
      {status === 'ready' ? (
        <VariantsPanel generation={generation} busy={busy} controller={controller} />
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
          {status === 'running' && steps.length > 0 ? <Progress steps={steps} /> : null}
          {error ? (
            <div
              role="alert"
              className="typography-body-small rounded-md bg-red-100 p-2 text-red-800"
            >
              {error.message}
              {error.action ? <span className="block text-red-700">{error.action}</span> : null}
            </div>
          ) : null}
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
                {error ? 'Retry' : 'Generate'}
              </Button>
            )}
          </footer>
        </form>
      )}
    </Popover>
  );
}
