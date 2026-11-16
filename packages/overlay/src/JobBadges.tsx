import type { Controller, Job, WidgetState } from './controller';
import { type BadgeState, jobBadge } from './model';
import { type Store, useStore } from './store';

const EDGE = 12;

const TONE: Record<BadgeState, string> = {
  draft: 'bg-white-1000 text-black-800 ring-1 ring-black-100',
  running: 'bg-blue-500 text-white-1000',
  ready: 'bg-green-600 text-white-1000',
  answer: 'bg-blue-700 text-white-1000',
  error: 'bg-red-600 text-white-1000',
};

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
  return (
    <>
      {jobs.map((job) => {
        const badge = badgeOf(job);
        const left = Math.min(
          Math.max(job.anchor.left + job.anchor.width, EDGE),
          window.innerWidth - EDGE,
        );
        const top = Math.min(Math.max(job.anchor.top, EDGE), window.innerHeight - EDGE);
        return (
          <button
            key={job.id}
            type="button"
            data-interactive=""
            aria-label={`Drawing ${job.number}: ${badge.text}`}
            aria-pressed={job.id === focus}
            className={`typography-body-small fixed flex h-6 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center gap-1 rounded-full border-0 px-2 font-[600] shadow-500 ${TONE[badge.state]} ${job.id === focus ? 'outline-2 outline-offset-1 outline-blue-500' : ''}`}
            style={{ left, top }}
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
          </button>
        );
      })}
    </>
  );
}
