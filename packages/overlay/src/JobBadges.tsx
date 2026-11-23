import { useSyncExternalStore } from 'react';
import type { Controller, Job, WidgetState } from './controller';
import { type BadgeState, badgeSpot, jobBadge, pagePath, sketchingOver } from './model';
import { type Store, useStore } from './store';
import { pageUrl } from './tracker';

const TONE: Record<BadgeState, string> = {
  draft: 'bg-white-1000 text-black-800 ring-1 ring-black-100',
  running: 'bg-blue-500 text-white-1000',
  ready: 'bg-green-600 text-white-1000',
  answer: 'bg-blue-700 text-white-1000',
  error: 'bg-red-600 text-white-1000',
};

const URL_CHECK_MS = 500;

function onUrlChange(notify: () => void): () => void {
  const timer = setInterval(notify, URL_CHECK_MS);
  window.addEventListener('popstate', notify);
  return () => {
    clearInterval(timer);
    window.removeEventListener('popstate', notify);
  };
}

function currentPage(): string {
  return pageUrl(window.location);
}

function badgeOf(job: Job) {
  const { generation } = job;
  return jobBadge({
    status: generation.status,
    variants: generation.variants.length,
    answered: generation.answer !== null && generation.variants.length === 0,
    failed: generation.error !== null,
  });
}

export function JobBadges({
  store,
  controller,
}: {
  store: Store<WidgetState>;
  controller: Controller;
}) {
  const jobs = useStore(store, (state) => state.jobs);
  const focus = useStore(store, (state) => state.focus);
  const mode = useStore(store, (state) => state.mode);
  const here = useSyncExternalStore(onUrlChange, currentPage);
  return (
    <>
      {jobs.map((job) => {
        const badge = badgeOf(job);
        const sketching = job.id === focus && sketchingOver(mode, job);
        const spot = badgeSpot(job.anchor, {
          width: window.innerWidth,
          height: window.innerHeight,
        });
        const away = job.page !== null && job.page !== here ? `Opens ${pagePath(job.page)}` : null;
        return (
          <button
            key={job.id}
            type="button"
            data-interactive={sketching ? undefined : ''}
            aria-label={`Drawing ${job.number}: ${badge.text}${away ? `. ${away}` : ''}`}
            aria-pressed={job.id === focus}
            title={away ?? undefined}
            className={`typography-body-small fixed flex h-6 -translate-x-full cursor-pointer items-center gap-1 rounded-full border-0 px-2 font-[600] shadow-500 ${TONE[badge.state]} ${job.id === focus ? 'outline-2 outline-offset-1 outline-blue-500' : ''}`}
            style={{ left: spot.right, top: spot.top }}
            onClick={() => void controller.focus(job.id)}
          >
            {badge.state === 'running' ? (
              <span
                aria-hidden="true"
                className="size-2 animate-pulse rounded-full bg-white-1000"
              />
            ) : null}
            <span>{job.number}</span>
            <span className="font-[450]">{badge.text}</span>
            {away ? <span aria-hidden="true">↗</span> : null}
          </button>
        );
      })}
    </>
  );
}
