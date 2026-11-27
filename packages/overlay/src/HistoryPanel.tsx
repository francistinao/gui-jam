import type { HistoryEntry } from '@guijam/contracts-ts';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { type Controller, HISTORY_KEY, type WidgetState } from './controller';
import { Button } from './figui/button';
import { Tab, Tabs, TabsList } from './figui/tabs';
import { onUrlChange } from './JobBadges';
import { type PanelSpot, pagePath, relativeTime } from './model';
import { Popover, PopoverHeader } from './Popover';
import type { Store } from './store';
import { pageKey } from './tracker';

type Filter = 'page' | 'all';

export function savedHistoryTab(): Filter | null {
  try {
    const value = sessionStorage.getItem(HISTORY_KEY);
    return value === null ? null : value === 'all' ? 'all' : 'page';
  } catch {
    return null;
  }
}

export function saveHistoryTab(tab: Filter | null): void {
  try {
    if (tab) sessionStorage.setItem(HISTORY_KEY, tab);
    else sessionStorage.removeItem(HISTORY_KEY);
  } catch {
    return;
  }
}

function currentKey(): string {
  return pageKey(window.location);
}

function fileName(path: string): string {
  return path.split('/').at(-1) ?? path;
}

function Row({
  entry,
  here,
  busy,
  controller,
  onFlip,
}: {
  entry: HistoryEntry;
  here: string;
  busy: boolean;
  controller: Controller;
  onFlip(entry: HistoryEntry): void;
}) {
  const undone = entry.state === 'undone';
  const file = entry.files[0] ?? '';
  const elsewhere = entry.pageUrl !== undefined && entry.pageUrl !== here;
  return (
    <li
      aria-label={`${entry.title}, ${file}`}
      className="flex items-start gap-2 rounded-md px-1 py-1.5 hover:bg-grey-100"
      onMouseEnter={() => controller.outline(elsewhere ? null : (entry.src ?? null))}
      onMouseLeave={() => controller.outline(null)}
    >
      <div className="min-w-0 flex-1">
        <p
          className={`typography-body-medium m-0 font-[500] ${undone ? 'text-grey-500 line-through' : ''}`}
          title={entry.prompt}
        >
          {entry.title}
        </p>
        <p className="typography-body-small m-0 truncate text-grey-500">
          {fileName(file)}
          {entry.files.length > 1 ? ` +${entry.files.length - 1}` : ''} ·{' '}
          {relativeTime(entry.atMs, Date.now())}
          {undone ? ' · Undone' : ''}
        </p>
        {elsewhere && entry.pageUrl ? (
          <Button
            variant="link"
            className="typography-body-small h-auto p-0"
            onClick={() => void controller.openHistoryPage(entry.pageUrl ?? here)}
          >
            Opens {pagePath(entry.pageUrl)} ↗
          </Button>
        ) : null}
      </div>
      <Button variant="secondary" disabled={busy} onClick={() => onFlip(entry)}>
        {undone ? 'Redo' : 'Undo'}
      </Button>
    </li>
  );
}

export function HistoryPanel({
  store,
  controller,
}: {
  store: Store<WidgetState>;
  controller: Controller;
}) {
  const here = useSyncExternalStore(onUrlChange, currentKey);
  const [filter, setFilter] = useState<Filter>(() => savedHistoryTab() ?? 'page');
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState<PanelSpot | null>(null);
  const latest = useRef(0);

  const load = useCallback(
    async (before: string | null) => {
      latest.current += 1;
      const sequence = latest.current;
      const found = await controller.listHistory(filter === 'page' ? here : null, before);
      if (sequence !== latest.current) return;
      if ('error' in found) {
        setError(found.error.message);
        return;
      }
      setError(null);
      setEntries((shown) => (before ? [...shown, ...found.entries] : found.entries));
      setMore(found.more);
    },
    [controller, filter, here],
  );

  useEffect(() => {
    const refresh = () => void load(null).then(() => setLoading(false));
    setLoading(true);
    refresh();
    let seen = store.get().historyVersion;
    const stop = store.subscribe(() => {
      const { historyVersion } = store.get();
      if (historyVersion === seen) return;
      seen = historyVersion;
      refresh();
    });
    window.addEventListener('focus', refresh);
    return () => {
      stop();
      window.removeEventListener('focus', refresh);
    };
  }, [load, store]);

  const flip = async (entry: HistoryEntry) => {
    setBusy(entry.id);
    if (entry.state === 'undone') await controller.redo(entry.id);
    else await controller.undo(entry.id);
    setBusy(null);
  };
  const close = () => {
    controller.outline(null);
    controller.closeHistory();
  };

  return (
    <Popover label="History" anchor={controller.toolbarRect()} at={at} onMove={setAt}>
      <PopoverHeader
        tag="History"
        subtitle="Changes applied with GUIJam"
        onClose={close}
        controller={controller}
      />
      <Tabs
        value={filter}
        onValueChange={(next) => {
          setFilter(next as Filter);
          saveHistoryTab(next as Filter);
        }}
      >
        <TabsList>
          <Tab value="page">This page</Tab>
          <Tab value="all">All pages</Tab>
        </TabsList>
      </Tabs>
      {error ? (
        <p role="alert" className="typography-body-small text-red-600">
          {error}
        </p>
      ) : null}
      {entries.length === 0 && !loading && !error ? (
        <p className="typography-body-medium py-3 text-grey-500">
          {filter === 'page' ? 'Nothing applied on this page yet.' : 'Nothing applied yet.'}
        </p>
      ) : (
        <ul aria-label="Changes" className="m-0 flex list-none flex-col p-0 pt-2">
          {entries.map((entry) => (
            <Row
              key={entry.id}
              entry={entry}
              here={here}
              busy={busy !== null}
              controller={controller}
              onFlip={(picked) => void flip(picked)}
            />
          ))}
        </ul>
      )}
      {more ? (
        <Button variant="ghost" onClick={() => void load(entries.at(-1)?.id ?? null)}>
          Show older
        </Button>
      ) : null}
    </Popover>
  );
}
