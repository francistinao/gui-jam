import { Circle, CircleCheck, ImagePlus, Link2, LoaderCircle, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AnswerPanel } from './AnswerPanel';
import { ACCEPTED_TYPES, type Attachment, imageFiles, MAX_ATTACHMENTS } from './attachments';
import type { Controller, ProgressStep, WidgetState } from './controller';
import { Button } from './figui/button';
import { cn } from './figui/cn';
import { INPUT_BASE_CLASS } from './figui/text-input';
import { formatElapsed, linksIn, MAX_LINKS, stillWorking } from './model';
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

function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

function Progress({
  steps,
  stepSince,
  now,
}: {
  steps: readonly ProgressStep[];
  stepSince: number | null;
  now: number;
}) {
  return (
    <ol aria-label="Progress" className="flex flex-col gap-1.5">
      {steps.map((step) => (
        <li
          key={step.label}
          data-state={step.state}
          className={cn(
            'typography-body-small flex items-start gap-2',
            step.state === 'pending' ? 'text-grey-400' : 'text-grey-800',
          )}
        >
          <StepIcon state={step.state} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-baseline justify-between gap-2">
              <span data-step-label="">{step.label}</span>
              {step.state === 'active' && stepSince !== null ? (
                <span data-step-elapsed="" className="flex-none text-grey-500 tabular-nums">
                  {formatElapsed(now - stepSince)}
                </span>
              ) : null}
            </span>
            {step.state === 'active' && step.detail ? (
              <span data-step-detail="" className="text-grey-500">
                {step.detail}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Thumbnails({
  attachments,
  disabled,
  controller,
}: {
  attachments: readonly Attachment[];
  disabled: boolean;
  controller: Controller;
}) {
  if (attachments.length === 0) return null;
  return (
    <ul aria-label="Attached images" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
      {attachments.map((attachment, index) => (
        <li key={attachment.id} className="relative">
          <img
            src={`data:${attachment.mediaType};base64,${attachment.base64}`}
            alt={`Attachment ${index + 1}: ${attachment.name}`}
            className="size-11 rounded-md object-cover ring-1 ring-black-100"
          />
          <button
            type="button"
            aria-label={`Remove image ${index + 1}`}
            disabled={disabled}
            onClick={() => controller.removeAttachment(attachment.id)}
            className="absolute -top-1.5 -right-1.5 grid size-4 cursor-pointer place-items-center rounded-full border-0 bg-grey-900 p-0 text-white-1000 disabled:hidden"
          >
            <X aria-hidden="true" className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function LinkChips({ prompt }: { prompt: string }) {
  const { links, skipped } = linksIn(prompt);
  if (links.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <ul aria-label="Links GUIJam will read" className="m-0 flex list-none flex-wrap gap-1 p-0">
        {links.map((link) => (
          <li
            key={link.href}
            title={link.href}
            className="typography-body-small flex max-w-full items-center gap-1 rounded-full bg-grey-100 px-2 py-0.5 text-grey-600"
          >
            <Link2 aria-hidden="true" className="size-3 shrink-0" />
            <span className="truncate">{link.label}</span>
          </li>
        ))}
      </ul>
      {skipped > 0 ? (
        <p role="note" className="typography-body-small m-0 text-grey-500">
          {`Only the first ${MAX_LINKS} links are read.`}
        </p>
      ) : null}
    </div>
  );
}

export function PromptPanel({ store, controller }: PanelProps) {
  const selection = useStore(store, (state) => state.selection);
  const anchor = useStore(store, (state) => state.anchor);
  const style = useStore(store, (state) => state.style);
  const job = useStore(store, (state) => state.jobs.find((entry) => entry.id === state.focus));
  const busy = useStore(store, (state) => state.busy);
  const now = useNow(job?.generation.status === 'running');
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

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
          {`Used ${selection.instances}× on this page. Changes apply to every instance.`}
        </p>
      ) : null}
      {answered ? (
        <AnswerPanel generation={generation} controller={controller} />
      ) : status === 'ready' ? (
        <VariantsPanel
          generation={generation}
          busy={busy}
          installing={job.installing}
          installError={job.installError}
          controller={controller}
        />
      ) : (
        <form
          className={cn(
            'flex flex-col gap-2 rounded-md',
            dragging && 'outline-2 outline-offset-2 outline-blue-500 outline-dashed',
          )}
          onSubmit={(event) => {
            event.preventDefault();
            void controller.generate();
          }}
          onDragOver={(event) => {
            if (status === 'running' || !event.dataTransfer.types.includes('Files')) return;
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            if (status === 'running' || event.dataTransfer.files.length === 0) return;
            event.preventDefault();
            setDragging(false);
            void controller.attach([...event.dataTransfer.files]);
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
            onPaste={(event) => {
              const images = imageFiles(event.clipboardData.files);
              if (images.length === 0) return;
              event.preventDefault();
              void controller.attach(images);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <LinkChips prompt={prompt} />
          <Thumbnails
            attachments={job.attachments}
            disabled={status === 'running'}
            controller={controller}
          />
          {job.attachError ? (
            <p role="alert" className="typography-body-small m-0 text-red-700">
              {job.attachError}
            </p>
          ) : null}
          <input
            ref={picker}
            type="file"
            accept={ACCEPTED_TYPES.join(',')}
            multiple
            hidden
            aria-label="Choose images"
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = '';
              void controller.attach(files);
            }}
          />
          {status === 'running' && steps.length > 0 ? (
            <Progress steps={steps} stepSince={generation.stepSince} now={now} />
          ) : null}
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
                <span
                  role="status"
                  className="typography-body-small mr-auto min-w-0 flex-1 text-grey-500"
                >
                  {stillWorking(now - (generation.startedAt ?? now), generation.timeoutMs, {
                    sketch: sketched,
                    images: job.attachments.length,
                    links: linksIn(prompt).links.length,
                  })}
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
                <span className="mr-auto flex items-center gap-1">
                  {sketched ? (
                    <Button
                      key="clear"
                      type="button"
                      variant="secondary"
                      onClick={() => void controller.discardJob()}
                    >
                      Clear sketch
                    </Button>
                  ) : null}
                  <Button
                    key="attach"
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Add image"
                    title={`Add inspiration images (up to ${MAX_ATTACHMENTS}). You can also paste or drop them.`}
                    disabled={job.attachments.length >= MAX_ATTACHMENTS}
                    onClick={() => picker.current?.click()}
                  >
                    <ImagePlus aria-hidden="true" />
                  </Button>
                </span>
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
