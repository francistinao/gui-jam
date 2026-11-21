import type { TicketSummary, TrackerProject } from '@guijam/contracts-ts';
import { Bug, ExternalLink, LoaderCircle, Ticket, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Controller, WidgetState } from './controller';
import { Button } from './figui/button';
import { TextInput } from './figui/text-input';
import { ReportForm } from './ReportToJira';
import { type Store, useStore } from './store';
import { isTicketKey, type LinkedTicket, loadingMessage, type TicketLoading } from './tracker';

const SEARCH_DELAY_MS = 300;
const NO_PROJECTS: readonly TrackerProject[] = [];
type Preset = 'assigned' | 'queued';
type Open = 'link' | 'report' | null;

const PRESETS: readonly { preset: Preset; label: string }[] = [
  { preset: 'assigned', label: 'Assigned to me' },
  { preset: 'queued', label: 'Sent to GUIJam' },
];

function Loading({ loading }: { loading: TicketLoading }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className="typography-body-small m-0 mb-2 flex items-center gap-2 rounded-md bg-blue-100 px-2 py-1.5 text-blue-900"
    >
      <LoaderCircle aria-hidden="true" className="size-4 flex-none animate-spin text-blue-500" />
      {loadingMessage(loading)}
    </p>
  );
}

function Linked({
  ticket,
  prompt,
  busy,
  controller,
}: {
  ticket: LinkedTicket;
  prompt: boolean;
  busy: boolean;
  controller: Controller;
}) {
  return (
    <section aria-label="Linked ticket" className="mb-2 rounded-md bg-blue-100 p-2 text-blue-900">
      <div className="flex items-start gap-2">
        <Ticket aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <a
          href={ticket.url}
          target="_blank"
          rel="noreferrer"
          className="typography-body-medium min-w-0 flex-1 font-[500] hover:underline"
        >
          {`${ticket.ref.key} · ${ticket.summary}`}
        </a>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Unlink ${ticket.ref.key}`}
          disabled={busy}
          onClick={controller.unlinkTicket}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="typography-body-small flex items-center gap-1">
          On apply, move to
          <select
            aria-label="Move the ticket to"
            value={ticket.transitionId ?? ''}
            className="typography-body-small h-6 cursor-pointer rounded-md border-0 bg-white-1000 px-1"
            onChange={(event) =>
              controller.setTicketOptions({ transitionId: event.target.value || null })
            }
          >
            <option value="">Don't move</option>
            {ticket.transitions.map((transition) => (
              <option key={transition.id} value={transition.id}>
                {transition.name}
              </option>
            ))}
          </select>
        </label>
        <label className="typography-body-small flex items-center gap-1">
          <input
            type="checkbox"
            checked={ticket.screenshots}
            onChange={(event) => controller.setTicketOptions({ screenshots: event.target.checked })}
          />
          Post before/after screenshots
        </label>
      </div>
      {prompt ? (
        <Button
          variant="link"
          className="mt-1 px-0"
          disabled={busy}
          onClick={() => void controller.fillPromptFromTicket()}
        >
          Use ticket text
        </Button>
      ) : null}
    </section>
  );
}

function Picker({
  controller,
  busy,
  onClose,
}: {
  controller: Controller;
  busy: boolean;
  onClose: () => void;
}) {
  const [preset, setPreset] = useState<Preset>('assigned');
  const [query, setQuery] = useState('');
  const [tickets, setTickets] = useState<TicketSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);

  useEffect(() => {
    const ask = ++asked.current;
    const timer = setTimeout(
      () => {
        void controller.searchTickets(preset, query).then((found) => {
          if (ask !== asked.current) return;
          if ('error' in found) {
            setError(found.error);
            setTickets([]);
          } else {
            setError(null);
            setTickets(found.tickets);
          }
        });
      },
      query ? SEARCH_DELAY_MS : 0,
    );
    return () => clearTimeout(timer);
  }, [preset, query, controller]);

  const link = async (summary: TicketSummary) => {
    if (await controller.linkTicket(summary.ref)) onClose();
  };

  return (
    <section aria-label="Link a Jira ticket" className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1">
        <TextInput
          aria-label="Ticket key or search"
          placeholder="WEB-12 or words from the ticket"
          value={query}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            const exact = tickets?.find((ticket) => ticket.ref.key === query.trim().toUpperCase());
            const first = exact ?? (tickets?.length === 1 ? tickets[0] : undefined);
            if (first) void link(first);
          }}
        />
        <Button variant="ghost" size="icon" aria-label="Close ticket search" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </div>
      <fieldset aria-label="Which tickets" className="m-0 flex gap-1 border-0 p-0">
        {PRESETS.map((entry) => (
          <Button
            key={entry.preset}
            variant={preset === entry.preset ? 'secondary' : 'ghost'}
            aria-pressed={preset === entry.preset}
            onClick={() => setPreset(entry.preset)}
          >
            {entry.label}
          </Button>
        ))}
      </fieldset>
      {error ? (
        <p role="alert" className="typography-body-small m-0 text-red-600">
          {error}
        </p>
      ) : null}
      {tickets === null ? (
        <p className="typography-body-small m-0 flex items-center gap-2 text-grey-500">
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          Looking in Jira…
        </p>
      ) : tickets.length === 0 && !error ? (
        <p className="typography-body-small m-0 text-grey-500">
          {query && isTicketKey(query)
            ? `${query.trim().toUpperCase()} isn't one you can open.`
            : 'No tickets here.'}
        </p>
      ) : (
        <ul
          aria-label="Tickets"
          className="m-0 flex max-h-48 list-none flex-col gap-0.5 overflow-auto p-0"
        >
          {tickets.map((ticket) => (
            <li key={ticket.ref.key} className="flex items-center gap-1">
              <Button
                variant="ghost"
                className="h-auto min-w-0 flex-1 justify-start py-1 text-left"
                disabled={busy}
                onClick={() => void link(ticket)}
              >
                <span className="truncate">{`${ticket.ref.key} · ${ticket.summary}`}</span>
              </Button>
              <a
                href={ticket.url}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open ${ticket.ref.key} in Jira`}
                className="text-grey-500 hover:text-grey-800"
              >
                <ExternalLink aria-hidden="true" className="size-4" />
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function TicketField({
  store,
  controller,
  ticket,
  prompt,
  report,
}: {
  store: Store<WidgetState>;
  controller: Controller;
  ticket: LinkedTicket | null;
  prompt: boolean;
  report: boolean;
}) {
  const paired = useStore(store, (state) => (state.tracker?.sites.length ?? 0) > 0);
  const projects = useStore(store, (state) => state.tracker?.sites[0]?.projects ?? NO_PROJECTS);
  const busy = useStore(store, (state) => state.busy);
  const loading = useStore(store, (state) => state.ticketLoading);
  const [open, setOpen] = useState<Open>(null);
  if (!paired) return null;
  if (loading) return <Loading loading={loading} />;
  if (ticket) {
    return <Linked ticket={ticket} prompt={prompt} busy={busy} controller={controller} />;
  }
  const reportable = report && projects.length > 0;
  const toggle = (which: Exclude<Open, null>) => setOpen(open === which ? null : which);
  return (
    <div className="mb-2 flex flex-col gap-1.5">
      <div className="flex items-center gap-4">
        <Button
          variant="link"
          className="px-0"
          aria-expanded={open === 'link'}
          disabled={busy}
          onClick={() => toggle('link')}
        >
          <Ticket aria-hidden="true" />
          Link a Jira ticket
        </Button>
        {reportable ? (
          <Button
            variant="link"
            className="px-0"
            aria-expanded={open === 'report'}
            disabled={busy}
            onClick={() => toggle('report')}
          >
            <Bug aria-hidden="true" />
            Report to Jira
          </Button>
        ) : null}
      </div>
      {open === 'link' ? (
        <Picker controller={controller} busy={busy} onClose={() => setOpen(null)} />
      ) : null}
      {open === 'report' && reportable ? (
        <ReportForm
          projects={projects}
          busy={busy}
          controller={controller}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}
