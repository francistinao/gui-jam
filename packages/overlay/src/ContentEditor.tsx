import type { ContentPart } from '@guijam/contracts-ts';
import { useLayoutEffect, useRef } from 'react';
import type { Controller, Draft } from './controller';
import { cn } from './figui/cn';
import { INPUT_BASE_CLASS } from './figui/text-input';
import { keyedParts } from './model';

const CHARS_PER_ROW = 34;
const MAX_ROWS = 5;

export function hasTextContent(parts: readonly ContentPart[] | undefined): boolean {
  return (parts ?? []).some((part) => part.kind !== 'element');
}

function TextRun({
  run,
  label,
  value,
  controller,
}: {
  run: number;
  label: string;
  value: string;
  controller: Controller;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (field.current && field.current.value !== value) field.current.value = value;
  }, [value]);
  const rows = Math.min(MAX_ROWS, Math.max(1, Math.ceil(value.length / CHARS_PER_ROW)));
  return (
    <textarea
      ref={field}
      aria-label={label}
      rows={rows}
      placeholder="Add text"
      className={cn(INPUT_BASE_CLASS, 'h-auto resize-none py-1')}
      onChange={(event) => controller.editText(run, event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          void controller.apply();
        }
      }}
    />
  );
}

export function ContentEditor({
  parts,
  draft,
  controller,
}: {
  parts: readonly ContentPart[];
  draft: Draft;
  controller: Controller;
}) {
  const runs = parts.filter((part) => part.kind === 'text').length;
  const coded = parts.some((part) => part.kind === 'code');
  return (
    <section aria-label="Content" className="flex flex-col gap-1.5 py-2">
      <h3 className="typography-body-medium m-0 font-[500]">Content</h3>
      {keyedParts(parts).map(({ key, part }) =>
        part.kind === 'text' ? (
          <TextRun
            key={key}
            run={part.run}
            label={runs > 1 ? `Text content ${part.run + 1}` : 'Text content'}
            value={draft.content?.[part.run] ?? part.value}
            controller={controller}
          />
        ) : part.kind === 'code' ? (
          <code
            key={key}
            title={part.source}
            className="typography-body-small block truncate rounded-md bg-grey-100 px-2 py-1 text-grey-600"
          >
            {part.source}
          </code>
        ) : (
          <span key={key} className="typography-body-small text-grey-500">
            {part.tag ? `<${part.tag}>` : '<>'}
          </span>
        ),
      )}
      {coded ? (
        <p className="typography-body-small m-0 text-grey-500">
          Text written as code comes from your app. Use Ask AI to change it.
        </p>
      ) : null}
    </section>
  );
}
