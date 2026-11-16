import { Circle, CircleCheck, LoaderCircle } from 'lucide-react';
import { AnswerPanel } from './AnswerPanel';
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
    return <CircleCheck aria-hidden="true" className="size-4 flex-none text-green-600" />;
  }
  if (state === 'active') {
    return (
      <LoaderCircle
        aria-hidden="true"
        data-spinner=""
        className="size-4 flex-none animate-spin text-blue-500"
      />
    );
  }
  return <Circle aria-hidden="true" className="size-4 flex-none text-grey-300" />;
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
  const job = useStore(store, (state) => state.jobs.find((entry) => entry.id === state.focus));
  const busy = useStore(store, (state) => state.busy);

  if (!selection || !anchor || !job) return null;
  const { generation } = job;
  const sketched = job.sketch !== null;
  const { prompt, status, steps, error } = generation;
  const answered =
    status === 'ready' && generation.answer !== null && generation.variants.length === 0;
  const badge = answered
    ? 'Answer'
    : status === 'ready'
      ? 'Variants'
      : status === 'running'
        ? 'Generating'
        : sketched
          ? 'Sketch'
          : 'Ask AI';

  return (
    <Popover label={`Ask AI ${selection.file}`} anchor={anchor}>
      <PopoverHeader
        tag={style?.tag}
        badge={badge}
        number={job.number}
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
      {answered ? (
        <AnswerPanel generation={generation} controller={controller} />
      ) : status === 'ready' ? (
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
            placeholder={sketched ? 'Describe what you sketched' : 'Make it pill-shaped and darker'}
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
                <Button
                  key="cancel"
                  type="button"
                  variant="secondary"
                  onClick={() => void controller.cancelGeneration()}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <>
                {sketched ? (
                  <Button
                    key="clear"
                    type="button"
                    variant="secondary"
                    className="mr-auto"
                    onClick={() => void controller.discardJob()}
                  >
                    Clear sketch
                  </Button>
                ) : null}
                <Button key="generate" type="submit" disabled={prompt.trim() === ''}>
                  {error ? 'Retry' : 'Generate'}
                </Button>
              </>
            )}
          </footer>
        </form>
      )}
    </Popover>
  );
}
