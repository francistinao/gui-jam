import type { ContentPart, FoundPart, TextPlace } from '@guijam/contracts-ts';
import { useLayoutEffect, useRef, useState } from 'react';
import type { Controller, Draft } from './controller';
import { cn } from './figui/cn';
import { INPUT_BASE_CLASS } from './figui/text-input';
import { keyedParts } from './model';

const CHARS_PER_ROW = 34;
const MAX_ROWS = 5;

export function hasTextContent(parts: readonly ContentPart[] | undefined): boolean {
  return (parts ?? []).some((part) => part.kind !== 'element');
}

export function placeName(place: TextPlace): string {
  const file = place.file.split('/').at(-1) ?? place.file;
  return `${place.label} · ${file}:${place.line}`;
}

function TextField({
  label,
  value,
  disabled = false,
  onEdit,
  controller,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onEdit: (value: string) => void;
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
      disabled={disabled}
      placeholder="Add text"
      className={cn(INPUT_BASE_CLASS, 'h-auto resize-none py-1 disabled:opacity-50')}
      onChange={(event) => onEdit(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          void controller.apply();
        }
      }}
    />
  );
}

function FoundText({
  part,
  draft,
  controller,
}: {
  part: FoundPart;
  draft: Draft;
  controller: Controller;
}) {
  const several = part.places.length > 1;
  const [chosen, setChosen] = useState<number | null>(() => {
    const drafted = draft.source?.place;
    const index = drafted
      ? part.places.findIndex(
          (place) =>
            place.file === drafted.file &&
            place.line === drafted.line &&
            place.column === drafted.column,
        )
      : -1;
    if (index >= 0) return index;
    return several ? null : 0;
  });
  const place = chosen === null ? undefined : part.places[chosen];
  const value = draft.source?.value ?? part.value;
  return (
    <>
      {several ? (
        <select
          aria-label="Where to edit"
          value={chosen ?? ''}
          className="typography-body-small h-6 w-full cursor-pointer rounded-md border-0 bg-grey-100 px-1"
          onChange={(event) => {
            const index = Number(event.target.value);
            const next = part.places[index];
            if (!next) return;
            setChosen(index);
            if (draft.source) controller.editSource(next, draft.source.value);
          }}
        >
          <option value="" disabled>
            {`Written in ${part.places.length} places. Choose one`}
          </option>
          {part.places.map((option, index) => (
            <option key={`${option.file}:${option.line}:${option.column}`} value={index}>
              {placeName(option)}
            </option>
          ))}
        </select>
      ) : null}
      <TextField
        label="Text content"
        value={value}
        disabled={!place}
        controller={controller}
        onEdit={(next) => {
          if (place) controller.editSource(place, next);
        }}
      />
      {place ? (
        <p className="typography-body-small m-0 truncate text-grey-500" title={place.file}>
          {`From ${placeName(place)}`}
        </p>
      ) : null}
    </>
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
  const editable = parts.some((part) => part.kind === 'text' || part.kind === 'found');
  const coded = parts.some((part) => part.kind === 'code');
  return (
    <section aria-label="Content" className="flex flex-col gap-1.5 py-2">
      <h3 className="typography-body-medium m-0 font-[500]">Content</h3>
      {keyedParts(parts).map(({ key, part }) => {
        if (part.kind === 'text') {
          return (
            <TextField
              key={key}
              label={runs > 1 ? `Text content ${part.run + 1}` : 'Text content'}
              value={draft.content?.[part.run] ?? part.value}
              controller={controller}
              onEdit={(value) => controller.editText(part.run, value)}
            />
          );
        }
        if (part.kind === 'found') {
          const placed = part.places
            .map((place) => `${place.file}:${place.line}:${place.column}`)
            .join('|');
          return (
            <FoundText
              key={`${key}:${part.code}:${placed}`}
              part={part}
              draft={draft}
              controller={controller}
            />
          );
        }
        if (part.kind === 'code') {
          return (
            <code
              key={key}
              title={part.source}
              className="typography-body-small block truncate rounded-md bg-grey-100 px-2 py-1 text-grey-600"
            >
              {part.source}
            </code>
          );
        }
        return (
          <span key={key} className="typography-body-small text-grey-500">
            {part.tag ? `<${part.tag}>` : '<>'}
          </span>
        );
      })}
      {coded && !editable ? (
        <p className="typography-body-small m-0 text-grey-500">
          Text written as code comes from your app. Use Ask AI to change it.
        </p>
      ) : null}
    </section>
  );
}
