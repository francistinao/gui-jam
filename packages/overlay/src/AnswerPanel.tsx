import type { Controller, Generation } from './controller';
import { Button } from './figui/button';
import { splitPaths } from './model';

const OPEN_IN_EDITOR = '/__open-in-editor';

function openInEditor(path: string): void {
  const url = new URL(OPEN_IN_EDITOR, import.meta.url);
  url.searchParams.set('file', path);
  void fetch(url);
}

interface AnswerPanelProps {
  generation: Generation;
  controller: Controller;
}

export function AnswerPanel({ generation, controller }: AnswerPanelProps) {
  const { answer, route, elapsedMs } = generation;
  if (answer === null) return null;
  const meta = [`${(elapsedMs / 1000).toFixed(1)} s`, route?.model].filter(Boolean).join(' · ');

  return (
    <section aria-label="Answer" className="flex flex-col gap-2">
      <p className="typography-body-medium whitespace-pre-wrap text-grey-800">
        {splitPaths(answer).map((part) =>
          'path' in part ? (
            <button
              key={part.at}
              type="button"
              title="Open in your editor"
              className="font-mono text-blue-600 underline-offset-2 hover:underline"
              onClick={() => openInEditor(part.path)}
            >
              {part.path}
            </button>
          ) : (
            <span key={part.at}>{part.text}</span>
          ),
        )}
      </p>
      <p className="typography-body-small text-grey-500">{meta}</p>
      <footer className="flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={() => void navigator.clipboard?.writeText(answer)}>
          Copy
        </Button>
        <Button onClick={() => void controller.askAnother()}>Ask another</Button>
      </footer>
    </section>
  );
}
