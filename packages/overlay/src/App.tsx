import { X } from 'lucide-react';
import type { Controller, WidgetState } from './controller';
import { FinetunePanel } from './FinetunePanel';
import { Button } from './figui/button';
import { JobBadges } from './JobBadges';
import type { Rect } from './model';
import { PromptPanel } from './PromptPanel';
import { type Store, useStore } from './store';

function Outline({ rect, dashed }: { rect: Rect; dashed?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={`fixed rounded-[2px] border-[1.5px] border-blue-500 ${dashed ? 'border-dashed' : ''}`}
      style={{
        left: rect.left - 2,
        top: rect.top - 2,
        width: rect.width + 4,
        height: rect.height + 4,
      }}
    />
  );
}

function Notice({ store, controller }: { store: Store<WidgetState>; controller: Controller }) {
  const notice = useStore(store, (state) => state.notice);
  if (!notice) return null;
  const { undoJournalId } = notice;
  return (
    <div
      role={notice.kind === 'error' ? 'alert' : 'status'}
      data-interactive=""
      className="typography-body-medium fixed bottom-20 left-1/2 flex max-w-[480px] -translate-x-1/2 items-center gap-3 rounded-lg bg-grey-900 px-3 py-2 text-white-1000 shadow-500"
    >
      <span>
        {notice.message}
        {notice.action ? <span className="block text-white-600">{notice.action}</span> : null}
      </span>
      {undoJournalId ? (
        <Button variant="link" onClick={() => void controller.undo(undoJournalId)}>
          Undo
        </Button>
      ) : null}
      <Button variant="ghost" size="icon" aria-label="Dismiss" onClick={controller.dismissNotice}>
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}

export function App({ store, controller }: { store: Store<WidgetState>; controller: Controller }) {
  const tool = useStore(store, (state) => state.tool);
  const hovered = useStore(store, (state) => state.hovered);
  const anchor = useStore(store, (state) => state.anchor);
  const mode = useStore(store, (state) => state.mode);
  const gone = useStore(store, (state) => state.selectionGone);
  return (
    <>
      {tool === 'select' && hovered ? <Outline rect={hovered} /> : null}
      {anchor && !gone ? <Outline rect={anchor} dashed /> : null}
      {mode === 'prompt' ? (
        <PromptPanel store={store} controller={controller} />
      ) : (
        <FinetunePanel store={store} controller={controller} />
      )}
      <JobBadges store={store} controller={controller} />
      <Notice store={store} controller={controller} />
    </>
  );
}
