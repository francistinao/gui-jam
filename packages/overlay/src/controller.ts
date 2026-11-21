import type {
  CodeChange,
  ElementStyle,
  FillValue,
  GenerateDone,
  GenerateProgress,
  GuijamMessage,
  RadiusValue,
  Route,
  Sketch,
  TextPlace,
  TicketRef,
  TicketSummary,
  TrackerStatus,
  VariantPreview,
} from '@guijam/contracts-ts';
import {
  type Attachment,
  checkSource,
  MAX_ATTACHMENTS,
  overflowNote,
  prepareImage,
  roomFor,
} from './attachments';
import { DomPreview } from './dom-preview';
import type { WidgetHost } from './host';
import {
  addStroke,
  appliedMessage,
  changesIn,
  classifyGesture,
  containerIndex,
  cssColor,
  editedFiles,
  finetuneProps,
  followedSrc,
  type HexColor,
  hexOfComputedColor,
  intersects,
  invertChanges,
  MAX_JOBS,
  MAX_TARGETS,
  nearestIndex,
  nextJobNumber,
  type Point,
  type Rect,
  redoStroke,
  type SketchState,
  samplePoints,
  shiftedLine,
  shownText,
  sketchAnchor,
  sketchOver,
  type Tool,
  toggleTarget,
  undoStroke,
  withoutInstalled,
} from './model';
import { collectPageOutline } from './page-outline';
import type { Saved } from './persist';
import { captureSketch, captureView } from './sketch';
import type { Store } from './store';
import {
  fileOfImage,
  type LinkedTicket,
  linkedTicket,
  pageUrl,
  promptFromTicket,
  type TicketLoading,
} from './tracker';

const PREVIEW_DEBOUNCE_MS = 120;
const UNDO_WINDOW_MS = 10_000;
const NOTICE_MS = 4_000;
const FOLLOW_MS = 2_000;
const TEXT_SETTLE_MS = 2_000;
const AFTER_CAPTURE_MS = 400;
const SEARCH_LIMIT = 8;
const SRC_ATTRIBUTE = 'data-gj-src';

export interface Selection {
  src: string;
  file: string;
  line: number;
  column: number;
  instances: number;
  instance?: number;
}

export interface Draft {
  fill?: FillValue;
  radius?: RadiusValue;
  content?: Record<number, string>;
  source?: { place: TextPlace; value: string };
}

export interface Notice {
  kind: 'info' | 'error';
  message: string;
  action?: string;
  undoJournalId?: string;
  link?: { label: string; href: string };
}

export type PanelMode = 'finetune' | 'prompt';

export type ProgressStep = GenerateProgress['steps'][number];

export interface Generation {
  prompt: string;
  status: 'idle' | 'running' | 'ready';
  runId: string | null;
  steps: ProgressStep[];
  variants: VariantPreview[];
  active: number;
  dropped: GenerateDone['dropped'];
  route: Route | null;
  elapsedMs: number;
  answer: string | null;
  error: Notice | null;
  notes: string[];
  startedAt: number | null;
  stepSince: number | null;
  timeoutMs: number | null;
  expectedMs: number | null;
  waiting: number;
}

const IDLE_GENERATION: Generation = {
  prompt: '',
  status: 'idle',
  runId: null,
  steps: [],
  variants: [],
  active: 0,
  dropped: [],
  route: null,
  elapsedMs: 0,
  answer: null,
  error: null,
  notes: [],
  startedAt: null,
  stepSince: null,
  timeoutMs: null,
  expectedMs: null,
  waiting: 0,
};

export interface Job {
  id: string;
  number: number;
  target: Selection;
  also: Selection[];
  anchor: Rect;
  strokes: Point[][];
  sketch: SketchState | null;
  generation: Generation;
  previewed: boolean;
  attachments: Attachment[];
  attachError: string | null;
  installing: boolean;
  installError: string | null;
  ticket: LinkedTicket | null;
}

export interface WidgetState {
  tool: Tool | null;
  jobs: Job[];
  focus: string | null;
  mode: PanelMode;
  hovered: Rect | null;
  selection: Selection | null;
  anchor: Rect | null;
  group: (Rect & { src: string })[];
  style: ElementStyle | null;
  current: { fill: HexColor | null; radiusPx: number | null } | null;
  draft: Draft;
  preview: { changesetId: string; changes: CodeChange[] } | null;
  busy: boolean;
  notice: Notice | null;
  selectionGone: boolean;
  tracker: TrackerStatus | null;
  ticket: LinkedTicket | null;
  pendingTicket: string | null;
  ticketLoading: TicketLoading | null;
}

export const initialState: WidgetState = {
  tool: null,
  jobs: [],
  focus: null,
  mode: 'finetune',
  hovered: null,
  selection: null,
  anchor: null,
  group: [],
  style: null,
  current: null,
  draft: {},
  preview: null,
  busy: false,
  notice: null,
  selectionGone: false,
  tracker: null,
  ticket: null,
  pendingTicket: null,
  ticketLoading: null,
};

export function rectOf(element: Element): Rect {
  const { left, top, width, height } = element.getBoundingClientRect();
  return { left, top, width, height };
}

export function parseSrc(src: string): Omit<Selection, 'instances'> | null {
  const match = /^(.+):(\d+):(\d+)$/.exec(src);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return { src, file: match[1], line: Number(match[2]), column: Number(match[3]) };
}

const SERVER_RENDERED = /\.astro$/;

function elementsAt(src: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[${SRC_ATTRIBUTE}="${CSS.escape(src)}"]`)];
}

function groupRects(targets: readonly Selection[]): WidgetState['group'] {
  return targets.flatMap(({ src }) =>
    elementsAt(src).map((element) => ({ src, ...rectOf(element) })),
  );
}

function growable(job: Job): boolean {
  const { status, variants } = job.generation;
  return status === 'idle' && variants.length === 0 && job.sketch === null;
}

function annotatedAround(stroke: Rect, exclude: Element): Element[] {
  const found = new Set<Element>();
  for (const { x, y } of samplePoints(stroke)) {
    for (const element of document.elementsFromPoint(x, y)) {
      if (element.hasAttribute(SRC_ATTRIBUTE) && !exclude.contains(element)) found.add(element);
    }
  }
  return [...found];
}

function areaOf(element: Element): number {
  const { width, height } = rectOf(element);
  return width * height;
}

function sketchContainer(bounds: Rect, exclude: Element): Element | null {
  const around = annotatedAround(bounds, exclude);
  const index = containerIndex(bounds, around.map(rectOf));
  if (index !== null) return around[index] ?? null;
  const largest = around.reduce<Element | null>(
    (best, element) => (best && areaOf(best) >= areaOf(element) ? best : element),
    null,
  );
  return largest ?? document.querySelector(`[${SRC_ATTRIBUTE}]`);
}

function fileOf(element: Element | null): string | undefined {
  const src = element?.getAttribute(SRC_ATTRIBUTE);
  return src ? parseSrc(src)?.file : undefined;
}

function pageNear(container: Element, bounds: Rect, exclude: Element): string | undefined {
  const file = fileOf(container);
  const roots = [...container.querySelectorAll(`[${SRC_ATTRIBUTE}]`)].filter((element) => {
    if (exclude.contains(element) || fileOf(element) === file) return false;
    const parent = element.parentElement?.closest(`[${SRC_ATTRIBUTE}]`) ?? null;
    return parent === container || fileOf(parent) === file;
  });
  const index = nearestIndex(bounds, roots.map(rectOf));
  return index === null ? undefined : (roots[index]?.getAttribute(SRC_ATTRIBUTE) ?? undefined);
}

function touchedBy(bounds: Rect, exclude: Element): string[] {
  const sources = [...document.querySelectorAll(`[${SRC_ATTRIBUTE}]`)]
    .filter((element) => !exclude.contains(element))
    .filter((element) => {
      const rect = rectOf(element);
      return intersects(rect, bounds) && containerIndex(bounds, [rect]) === null;
    })
    .map((element) => element.getAttribute(SRC_ATTRIBUTE) ?? '')
    .filter((src) => src !== '');
  return [...new Set(sources)].slice(0, 20);
}

function readCurrent(element: Element): WidgetState['current'] {
  const computed = getComputedStyle(element);
  const radius = Number.parseFloat(computed.borderTopLeftRadius);
  return {
    fill: hexOfComputedColor(computed.backgroundColor),
    radiusPx: Number.isFinite(radius) ? radius : null,
  };
}

function failure(reply: GuijamMessage): Notice {
  if (reply.type === 'error') {
    const notice: Notice = { kind: 'error', message: reply.payload.message };
    if (reply.payload.action) notice.action = reply.payload.action;
    return notice;
  }
  return { kind: 'error', message: `Unexpected reply: ${reply.type}` };
}

function boxOf(rect: Rect): [number, number, number, number] {
  return [
    Math.round(rect.left),
    Math.round(rect.top),
    Math.round(rect.width),
    Math.round(rect.height),
  ];
}

export type Controller = ReturnType<typeof createController>;

export function createController(host: WidgetHost, store: Store<WidgetState>) {
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let following: MutationObserver | undefined;
  let followTimer: ReturnType<typeof setTimeout> | undefined;
  let previewing: Promise<void> | undefined;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let editSequence = 0;
  let selectSequence = 0;
  let previousFocus: string | null = null;
  const runs = new Map<string, string>();
  const committed = new Map<string, CodeChange[]>();
  const styled = new Set<HTMLElement>();
  const domPreview = new DomPreview<HTMLElement>();

  host.onEvent((message) => {
    if (message.type !== 'generate.progress') return;
    const jobId = runs.get(message.payload.runId);
    if (!jobId) return;
    const { steps, timeoutMs, expectedMs, variants, waiting, update } = message.payload;
    if (update) {
      store.set({
        jobs: store
          .get()
          .jobs.map((entry) => (entry.id === jobId ? entry : { ...entry, previewed: false })),
      });
      followSelection(jobId);
    }
    updateJob(jobId, (job) => {
      const before = job.generation.steps.find((step) => step.state === 'active')?.label;
      const after = steps.find((step) => step.state === 'active')?.label;
      const stepSince = before === after ? job.generation.stepSince : Date.now();
      const arrived = variants ?? [];
      const current = job.generation.variants[job.generation.active]?.changesetId;
      const active = Math.max(
        0,
        update
          ? arrived.findIndex((variant) => !variant.needs)
          : arrived.findIndex((variant) => variant.changesetId === current),
      );
      return {
        ...job,
        previewed: job.previewed || update !== undefined,
        generation: {
          ...job.generation,
          steps,
          stepSince,
          timeoutMs: timeoutMs ?? job.generation.timeoutMs,
          expectedMs: expectedMs ?? job.generation.expectedMs,
          ...(arrived.length > 0 ? { variants: [...arrived], active, waiting: waiting ?? 0 } : {}),
        },
      };
    });
  });

  function jobById(id: string | null): Job | undefined {
    return id === null ? undefined : store.get().jobs.find((job) => job.id === id);
  }

  function focused(): Job | undefined {
    return jobById(store.get().focus);
  }

  function updateJob(id: string, change: (job: Job) => Job): void {
    store.set({ jobs: store.get().jobs.map((job) => (job.id === id ? change(job) : job)) });
  }

  function setGeneration(id: string, generation: Generation): void {
    updateJob(id, (job) => ({ ...job, generation }));
  }

  function removeJob(id: string): void {
    store.set({ jobs: store.get().jobs.filter((job) => job.id !== id) });
    if (previousFocus === id) previousFocus = null;
  }

  function editSketch(edit: (sketch: SketchState) => SketchState): boolean {
    const job = focused();
    if (!job?.sketch || job.generation.status !== 'idle') return false;
    const sketch = edit(job.sketch);
    if (sketch === job.sketch) return false;
    const anchor = sketchAnchor(sketch);
    updateJob(job.id, (entry) => ({ ...entry, sketch, strokes: sketch.strokes, anchor }));
    store.set({ anchor });
    return true;
  }

  function clearPanel(): void {
    store.set({
      focus: null,
      ticket: null,
      selection: null,
      anchor: null,
      group: [],
      style: null,
      current: null,
      mode: 'finetune',
      selectionGone: false,
    });
  }

  function followSelection(jobId: string): void {
    following?.disconnect();
    clearTimeout(followTimer);
    let scheduled = false;
    const check = () => {
      scheduled = false;
      const { focus, selection } = store.get();
      const job = jobById(jobId);
      if (focus !== jobId || !job || job.sketch || !selection) return;
      const variant = job.generation.variants[job.generation.active];
      const { src, touched } = variant
        ? followedSrc(selection, variant.changes)
        : { src: selection.src, touched: false };
      const element = elementsAt(src)[0] ?? elementsAt(selection.src)[0];
      if (element) {
        store.set({ anchor: rectOf(element), group: groupRects(job.also), selectionGone: false });
      } else if (!touched) store.set({ selectionGone: true });
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(check);
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    following = observer;
    followTimer = setTimeout(() => observer.disconnect(), FOLLOW_MS);
  }

  function notify(notice: Notice | null, durationMs = NOTICE_MS): void {
    clearTimeout(noticeTimer);
    store.set({ notice });
    if (notice) noticeTimer = setTimeout(() => store.set({ notice: null }), durationMs);
  }

  function optimisticFill(fill: FillValue | undefined, style: ElementStyle | null): string | null {
    if (!fill) return null;
    switch (fill.kind) {
      case 'hex':
        return cssColor({ hex: fill.hex, opacity: fill.opacity });
      case 'token':
        return style?.theme.colors.find((color) => color.name === fill.name)?.value ?? null;
      case 'none':
        return 'transparent';
    }
  }

  function optimisticRadius(
    radius: RadiusValue | undefined,
    style: ElementStyle | null,
  ): string | null {
    if (!radius) return null;
    switch (radius.kind) {
      case 'px':
        return `${radius.px}px`;
      case 'full':
        return '9999px';
      case 'token': {
        const px = style?.theme.radii.find((entry) => entry.name === radius.name)?.px;
        return px === undefined ? null : `${px}px`;
      }
    }
  }

  function applyOptimistic(draft: Draft, selection: Selection): void {
    const { style } = store.get();
    const fill = optimisticFill(draft.fill, style);
    const radius = optimisticRadius(draft.radius, style);
    for (const element of elementsAt(selection.src)) {
      if (SERVER_RENDERED.test(selection.file)) domPreview.remember(element);
      if (fill !== null) element.style.backgroundColor = fill;
      if (radius !== null) element.style.borderRadius = radius;
      styled.add(element);
    }
  }

  function clearOptimistic(): void {
    for (const element of styled) {
      element.style.removeProperty('background-color');
      element.style.removeProperty('border-radius');
    }
    styled.clear();
  }

  function setDraft(next: Draft): void {
    const { selection } = store.get();
    if (!selection) return;
    editSequence += 1;
    const sequence = editSequence;
    store.set({ draft: next });
    applyOptimistic(next, selection);
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      previewTimer = undefined;
      previewing = preview(sequence);
    }, PREVIEW_DEBOUNCE_MS);
  }

  function textChanged(element: HTMLElement | undefined): Promise<void> {
    if (!element) return Promise.resolve();
    const before = element.textContent;
    return new Promise((done) => {
      const observer = new MutationObserver(() => {
        if (element.textContent === before) return;
        finish();
      });
      const timer = setTimeout(() => finish(), TEXT_SETTLE_MS);
      function finish(): void {
        observer.disconnect();
        clearTimeout(timer);
        done();
      }
      observer.observe(element, { characterData: true, childList: true, subtree: true });
    });
  }

  async function inspect(selection: Selection, quiet = false): Promise<void> {
    const element = elementsAt(selection.src)[selection.instance ?? 0];
    const text = shownText(element?.textContent ?? null);
    const reply = await host.request({
      type: 'element.inspect',
      payload: {
        file: selection.file,
        line: selection.line,
        column: selection.column,
        ...(text === undefined ? {} : { text }),
      },
    });
    if (store.get().selection?.src !== selection.src) return;
    if (reply.type === 'element.style') store.set({ style: reply.payload });
    else if (quiet) clearPanel();
    else notify(failure(reply));
  }

  function hasUnsaved(): boolean {
    const { draft, preview } = store.get();
    return preview !== null || Object.keys(draft).length > 0;
  }

  async function revert(notice?: string): Promise<void> {
    clearTimeout(previewTimer);
    previewTimer = undefined;
    editSequence += 1;
    clearOptimistic();
    domPreview.revert();
    const { preview } = store.get();
    store.set({ draft: {}, preview: null });
    if (preview) {
      await host.request({
        type: 'changeset.discard',
        payload: { changesetId: preview.changesetId },
      });
    }
    if (notice) notify({ kind: 'info', message: notice });
  }

  async function preview(sequence: number): Promise<void> {
    const { selection, draft } = store.get();
    if (!selection) return;
    const reply = await host.request({
      type: 'finetune.preview',
      payload: {
        file: selection.file,
        line: selection.line,
        column: selection.column,
        props: finetuneProps(draft),
      },
    });
    if (sequence !== editSequence) return;
    if (reply.type !== 'finetune.previewed') {
      clearOptimistic();
      domPreview.revert();
      store.set({ preview: null });
      notify(failure(reply));
      return;
    }
    clearOptimistic();
    const { dom } = reply.payload;
    if (dom) {
      const all = elementsAt(dom.src);
      const clicked = draft.source ? all[selection.instance ?? 0] : undefined;
      domPreview.apply(dom, all, clicked ? [clicked] : all);
    } else domPreview.revert();
    store.set({
      preview: { changesetId: reply.payload.changesetId, changes: reply.payload.changes },
    });
  }

  async function settle(job: Job): Promise<void> {
    const { runId, status } = job.generation;
    if (!runId) return;
    if (status === 'running') {
      runs.delete(runId);
      await host.request({ type: 'generate.cancel', payload: { runId } });
    } else if (status === 'ready') {
      await host.request({ type: 'generate.discard', payload: { runId } });
    }
  }

  async function run(jobId: string, forceAi: boolean): Promise<void> {
    const job = jobById(jobId);
    if (!job) return;
    const prompt = job.generation.prompt.trim();
    if (!prompt || job.generation.status !== 'idle') return;
    const runId = crypto.randomUUID();
    runs.set(runId, jobId);
    store.set({
      jobs: store.get().jobs.map((entry) =>
        entry.id === jobId
          ? {
              ...entry,
              previewed: false,
              generation: {
                ...IDLE_GENERATION,
                prompt,
                status: 'running',
                runId,
                startedAt: Date.now(),
                stepSince: Date.now(),
              },
            }
          : entry,
      ),
    });
    const drawn =
      job.sketch && job.sketch.strokes.length > 0
        ? await sketchRequest(job.sketch, job.target)
        : null;
    if (!runs.has(runId)) return;
    const reply = await host.request({
      type: 'generate.request',
      payload: {
        runId,
        file: job.target.file,
        line: job.target.line,
        column: job.target.column,
        prompt,
        ...(job.also.length > 0
          ? { alsoSelected: job.also.map(({ file, line, column }) => ({ file, line, column })) }
          : {}),
        page: collectPageOutline(document, host.hostElement),
        ...(drawn ? { sketch: drawn } : {}),
        ...(job.attachments.length > 0
          ? {
              attachments: {
                images: job.attachments.map(({ mediaType, base64 }) => ({ mediaType, base64 })),
              },
            }
          : {}),
        ...(forceAi ? { forceAi } : {}),
      },
    });
    finishRun(runId, reply);
  }

  function finishRun(runId: string, reply: GuijamMessage): void {
    const owner = runs.get(runId);
    runs.delete(runId);
    const latest = jobById(owner ?? null);
    if (!latest || latest.generation.runId !== runId) {
      if (reply.type === 'generate.done') {
        void host.request({ type: 'generate.discard', payload: { runId } });
      }
      return;
    }
    if (reply.type !== 'generate.done') {
      setGeneration(latest.id, {
        ...IDLE_GENERATION,
        prompt: latest.generation.prompt,
        error: failure(reply),
      });
      return;
    }
    const { variants, dropped, route, elapsedMs, answer, update, notes } = reply.payload;
    const previewed = update !== undefined;
    store.set({
      jobs: store.get().jobs.map((entry) => {
        if (entry.id !== latest.id) return previewed ? { ...entry, previewed: false } : entry;
        return {
          ...entry,
          previewed,
          generation: {
            ...entry.generation,
            status: 'ready',
            variants: [...variants],
            active: Math.max(
              0,
              variants.findIndex(
                (variant) =>
                  variant.changesetId ===
                  entry.generation.variants[entry.generation.active]?.changesetId,
              ),
            ),
            waiting: 0,
            dropped,
            route,
            elapsedMs,
            answer: answer ?? null,
            notes: [...(notes ?? [])],
          },
        };
      }),
    });
  }

  async function reattach(jobId: string, runId: string): Promise<void> {
    runs.set(runId, jobId);
    const reply = await host.request({ type: 'generate.attach', payload: { runId } });
    finishRun(runId, reply);
  }

  async function reshow(job: Job): Promise<void> {
    const variant = job.generation.variants[job.generation.active];
    if (!job.generation.runId || !variant) return;
    const reply = await host.request({
      type: 'variant.select',
      payload: { runId: job.generation.runId, changesetId: variant.changesetId },
    });
    if (reply.type === 'variant.selected') {
      followSelection(job.id);
      return;
    }
    setGeneration(job.id, {
      ...IDLE_GENERATION,
      prompt: job.generation.prompt,
      error: {
        kind: 'error',
        message: 'Its variants were lost while the page reloaded.',
        action: 'Generate again.',
      },
    });
    updateJob(job.id, (entry) => ({ ...entry, previewed: false }));
  }

  async function showVariant(jobId: string, index: number): Promise<void> {
    const job = jobById(jobId);
    const variant = job?.generation.variants[index];
    if (!job?.generation.runId || !variant) return;
    selectSequence += 1;
    const sequence = selectSequence;
    store.set({
      jobs: store
        .get()
        .jobs.map((entry) =>
          entry.id === jobId
            ? { ...entry, previewed: true, generation: { ...entry.generation, active: index } }
            : { ...entry, previewed: false },
        ),
    });
    const reply = await host.request({
      type: 'variant.select',
      payload: { runId: job.generation.runId, changesetId: variant.changesetId },
    });
    if (reply.type === 'variant.selected') {
      followSelection(jobId);
      return;
    }
    updateJob(jobId, (entry) => ({ ...entry, previewed: false }));
    if (sequence === selectSequence) notify(failure(reply), UNDO_WINDOW_MS);
  }

  async function sketchRequest(sketch: SketchState, target: Selection): Promise<Sketch> {
    const { bounds, element } = sketch;
    const started = performance.now();
    const images = await captureSketch(
      sketch.strokes,
      bounds,
      host.hostElement,
      element ? sketchAnchor(sketch) : undefined,
    );
    const touching = touchedBy(bounds, host.hostElement);
    const container = element ? undefined : elementsAt(target.src)[0];
    const near = container ? pageNear(container, bounds, host.hostElement) : undefined;
    return {
      images,
      captureMs: Math.round(performance.now() - started),
      box: boxOf(bounds),
      touching: element ? touching.filter((src) => src !== target.src) : touching,
      ...(element ? { elementBox: boxOf(element) } : {}),
      ...(near ? { near } : {}),
    };
  }

  function selectionOf(element: Element): Selection | null {
    const src = element.getAttribute(SRC_ATTRIBUTE);
    const parsed = src === null ? null : parseSrc(src);
    if (!parsed) return null;
    const elements: Element[] = elementsAt(parsed.src);
    const instance = Math.max(0, elements.indexOf(element));
    return { ...parsed, instances: elements.length, instance };
  }

  async function focusJob(id: string): Promise<void> {
    const job = jobById(id);
    if (!job) return;
    if (hasUnsaved()) await revert('Unsaved tweaks were reverted.');
    const { focus } = store.get();
    if (focus !== id) previousFocus = focus;
    store.set({
      focus: id,
      mode: 'prompt',
      selection: job.target,
      anchor: job.anchor,
      group: groupRects(job.also),
      style: null,
      current: null,
      draft: {},
      preview: null,
      selectionGone: false,
    });
    const { generation } = job;
    if (generation.status === 'ready' && generation.variants.length > 0 && !job.previewed) {
      void showVariant(id, generation.active);
    }
    await inspect(job.target);
  }

  function ticketTarget(): { ticket: LinkedTicket | null; target: Selection | null } {
    const job = focused();
    if (job) return { ticket: job.ticket, target: job.target };
    const { ticket, selection } = store.get();
    return { ticket, target: selection };
  }

  function setTicket(ticket: LinkedTicket | null): void {
    const job = focused();
    if (job) updateJob(job.id, (entry) => ({ ...entry, ticket }));
    else store.set({ ticket });
  }

  function willFill(): boolean {
    const job = focused();
    return Boolean(job && job.generation.status === 'idle' && !job.generation.prompt.trim());
  }

  async function linkTicket(ref: TicketRef): Promise<boolean> {
    const { target } = ticketTarget();
    if (!target || store.get().ticketLoading) return false;
    const fills = willFill();
    store.set({ ticketLoading: { key: ref.key, step: 'reading', images: 0, fills } });
    try {
      const reply = await host.request({ type: 'tracker.ticket', payload: { ref } });
      if (reply.type !== 'tracker.ticket.ok') {
        notify(failure(reply));
        return false;
      }
      const images = Math.min(reply.payload.images.length, MAX_ATTACHMENTS);
      store.set({ ticketLoading: { key: ref.key, step: 'screenshot', images, fills } });
      const element = elementsAt(target.src)[target.instance ?? 0];
      const before = element ? await captureView(host.hostElement, element) : [];
      setTicket(linkedTicket(reply.payload, before));
      void host
        .request({
          type: 'tracker.start',
          payload: { ref, pageUrl: pageUrl(window.location), src: target.src },
        })
        .then((started) => {
          if (started.type === 'error') notify(failure(started));
        });
      if (fills && willFill()) await fillPrompt();
      return true;
    } finally {
      store.set({ ticketLoading: null });
    }
  }

  async function fillPrompt(): Promise<void> {
    const job = focused();
    const ticket = job?.ticket;
    if (!job || !ticket) return;
    const room = Math.max(0, MAX_ATTACHMENTS - job.attachments.length);
    const images = ticket.images.slice(0, room);
    store.set({
      ticketLoading: { key: ticket.ref.key, step: 'prompt', images: images.length, fills: true },
    });
    setGeneration(job.id, { ...job.generation, prompt: promptFromTicket(ticket) });
    if (images.length > 0) await controllerApi.attach(images.map(fileOfImage));
  }

  async function fillPromptFromTicket(): Promise<void> {
    if (store.get().ticketLoading) return;
    try {
      await fillPrompt();
    } finally {
      store.set({ ticketLoading: null });
    }
  }

  function settled(): Promise<void> {
    return new Promise((done) => {
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, AFTER_CAPTURE_MS)));
    });
  }

  function postToTicket(ticket: LinkedTicket, journalId: string, src: string): void {
    const { key } = ticket.ref;
    void (async () => {
      await settled();
      const element = elementsAt(src)[0];
      const after =
        ticket.screenshots && element ? await captureView(host.hostElement, element) : [];
      const reply = await host.request({
        type: 'tracker.post',
        payload: {
          ref: ticket.ref,
          journalId,
          pageUrl: pageUrl(window.location),
          src,
          before: ticket.screenshots ? ticket.before : [],
          after,
          ...(ticket.transitionId ? { transitionId: ticket.transitionId } : {}),
        },
      });
      if (reply.type !== 'tracker.posted') {
        notify(failure(reply), UNDO_WINDOW_MS);
        return;
      }
      if (reply.payload.outcome === 'cancelled') {
        notify({ kind: 'info', message: `Change undone. Nothing was posted to ${key}.` });
        return;
      }
      notify(
        {
          kind: 'info',
          message: `Posted to ${key}.`,
          link: { label: `Open ${key}`, href: reply.payload.url },
        },
        UNDO_WINDOW_MS,
      );
    })();
  }

  function withTicketNote(notice: Notice, ticket: LinkedTicket | null): Notice {
    return ticket
      ? { ...notice, action: `Posts to ${ticket.ref.key} in 10 s unless you undo.` }
      : notice;
  }

  async function addJob(
    target: Selection,
    anchor: Rect,
    strokes: Point[][],
    sketch: SketchState | null,
    also: Selection[] = [],
  ): Promise<void> {
    const { jobs } = store.get();
    const job: Job = {
      id: crypto.randomUUID(),
      number: nextJobNumber(jobs.map((entry) => entry.number)),
      target,
      also,
      anchor,
      strokes,
      sketch,
      generation: IDLE_GENERATION,
      previewed: false,
      attachments: [],
      attachError: null,
      installing: false,
      installError: null,
      ticket: store.get().selection?.src === target.src ? store.get().ticket : null,
    };
    store.set({ jobs: [...jobs, job] });
    await focusJob(job.id);
  }

  function atLimit(): boolean {
    if (store.get().jobs.length < MAX_JOBS) return false;
    notify({
      kind: 'info',
      message: `Up to ${MAX_JOBS} drawings at a time. Use or discard one first.`,
    });
    return true;
  }

  async function openFinetune(element: Element): Promise<void> {
    const selection = selectionOf(element);
    if (!selection) return;
    if (hasUnsaved()) await revert('Unsaved tweaks were reverted.');
    store.set({
      focus: null,
      selection,
      mode: 'finetune',
      anchor: rectOf(element),
      group: [],
      style: null,
      current: readCurrent(element),
      draft: {},
      preview: null,
      selectionGone: false,
      ticket: null,
    });
    await inspect(selection);
    const { pendingTicket, tracker } = store.get();
    const site = tracker?.sites[0]?.site;
    if (pendingTicket && site) {
      store.set({ pendingTicket: null });
      await linkTicket({ provider: 'jira', site, key: pendingTicket });
    }
  }

  function regroup(job: Job, picked: Selection): void {
    const result = toggleTarget([job.target, ...job.also], picked);
    if ('full' in result) {
      notify({ kind: 'info', message: `Up to ${MAX_TARGETS} components at a time.` });
      return;
    }
    const [target, ...also] = result.targets;
    if (!target || result.targets.length === job.also.length + 1) return;
    const moved = target.src !== job.target.src;
    const element = moved ? elementsAt(target.src)[0] : undefined;
    const anchor = element ? rectOf(element) : job.anchor;
    updateJob(job.id, (entry) => ({ ...entry, target, also, anchor }));
    store.set({
      group: groupRects(also),
      ...(moved ? { selection: target, anchor, style: null } : {}),
    });
    if (moved) void inspect(target);
  }

  async function extend(element: Element): Promise<void> {
    const picked = selectionOf(element);
    if (!picked) return;
    const job = focused();
    if (job) {
      if (growable(job)) regroup(job, picked);
      else await openFinetune(element);
      return;
    }
    const { selection, anchor } = store.get();
    if (!selection || !anchor) {
      await openFinetune(element);
      return;
    }
    if (selection.src === picked.src) return;
    await revert(hasUnsaved() ? 'Unsaved tweaks were reverted.' : undefined);
    if (atLimit()) return;
    await addJob(selection, anchor, [], null, [picked]);
  }

  const controllerApi = {
    select: (element: Element, additive = false) =>
      additive ? extend(element) : openFinetune(element),

    async loadTracker(): Promise<void> {
      const reply = await host.request({ type: 'tracker.status', payload: {} });
      store.set({ tracker: reply.type === 'tracker.status.ok' ? reply.payload : null });
    },

    async searchTickets(
      preset: 'assigned' | 'queued',
      query: string,
    ): Promise<{ tickets: TicketSummary[] } | { error: string }> {
      const site = store.get().tracker?.sites[0]?.site;
      const reply = await host.request({
        type: 'tracker.search',
        payload: {
          preset,
          ...(site ? { site } : {}),
          ...(query.trim() ? { query: query.trim().slice(0, 200) } : {}),
        },
      });
      if (reply.type === 'tracker.tickets') {
        return { tickets: reply.payload.tickets.slice(0, SEARCH_LIMIT) };
      }
      return { error: reply.type === 'error' ? reply.payload.message : 'Jira did not answer.' };
    },

    linkTicket,

    fillPromptFromTicket,

    unlinkTicket(): void {
      setTicket(null);
    },

    setTicketOptions(change: Partial<Pick<LinkedTicket, 'transitionId' | 'screenshots'>>): void {
      const { ticket } = ticketTarget();
      if (ticket) setTicket({ ...ticket, ...change });
    },

    openTicketLink(key: string): void {
      store.set({ pendingTicket: key, tool: 'select' });
      host.onToolChange('select');
      notify({ kind: 'info', message: `Select the element for ${key}.` }, UNDO_WINDOW_MS);
    },

    async reportToJira(report: {
      project: string;
      summary: string;
      description: string;
    }): Promise<boolean> {
      const { selection, tracker } = store.get();
      const site = tracker?.sites[0]?.site;
      if (!selection || !site) return false;
      const element = elementsAt(selection.src)[selection.instance ?? 0];
      const [image] = element ? await captureView(host.hostElement, element) : [];
      if (!image) {
        notify({ kind: 'error', message: 'Could not take a screenshot of this element.' });
        return false;
      }
      store.set({ busy: true });
      const reply = await host.request({
        type: 'tracker.report',
        payload: {
          site,
          project: report.project,
          summary: report.summary.trim().slice(0, 255),
          description: report.description.slice(0, 4000),
          pageUrl: pageUrl(window.location),
          src: selection.src,
          image,
        },
      });
      store.set({ busy: false });
      if (reply.type !== 'tracker.reported') {
        notify(failure(reply), UNDO_WINDOW_MS);
        return false;
      }
      const { key } = reply.payload.ref;
      notify(
        {
          kind: 'info',
          message: `Created ${key}.`,
          link: { label: `Open ${key}`, href: reply.payload.url },
        },
        UNDO_WINDOW_MS,
      );
      return true;
    },

    removeTarget(src: string): void {
      const job = focused();
      const target = job ? [job.target, ...job.also].find((entry) => entry.src === src) : undefined;
      if (job && target && growable(job)) regroup(job, target);
    },

    focus: (id: string) => focusJob(id),

    async draw(points: Point[], bounds: Rect): Promise<boolean> {
      if (editSketch((sketch) => addStroke(sketch, points, bounds))) return true;
      if (atLimit()) return false;
      const around = annotatedAround(bounds, host.hostElement);
      const gesture = classifyGesture(points, around.map(rectOf));
      const element = gesture.kind === 'select' ? around[gesture.index] : undefined;
      const circled = element ? selectionOf(element) : null;
      if (element && circled) {
        await addJob(circled, rectOf(element), [points], null);
        return true;
      }
      const container = sketchContainer(bounds, host.hostElement);
      const target = container ? selectionOf(container) : null;
      if (!target) {
        notify({ kind: 'info', message: 'Nothing editable on this page.' });
        return false;
      }
      await addJob(target, bounds, [points], { strokes: [points], undone: [], bounds });
      return true;
    },

    async askAI(): Promise<void> {
      const { selection, anchor } = store.get();
      await revert(hasUnsaved() ? 'Unsaved tweaks were reverted.' : undefined);
      if (!selection || !anchor || atLimit()) return;
      await addJob(selection, anchor, [], null);
    },

    async startSketch(): Promise<void> {
      const job = focused();
      if (job) {
        const plain =
          !job.sketch &&
          job.strokes.length === 0 &&
          job.also.length === 0 &&
          job.generation.status === 'idle';
        if (!plain) return;
        const element = elementsAt(job.target.src)[0];
        const anchor = element ? rectOf(element) : job.anchor;
        updateJob(job.id, (entry) => ({ ...entry, anchor, sketch: sketchOver(anchor) }));
        store.set({ anchor });
        return;
      }
      const { selection, anchor } = store.get();
      await revert(hasUnsaved() ? 'Unsaved tweaks were reverted.' : undefined);
      if (!selection || !anchor || atLimit()) return;
      await addJob(selection, anchor, [], sketchOver(anchor));
    },

    clearSketch(): void {
      const job = focused();
      const element = job?.sketch?.element;
      if (!job || !element || job.generation.status !== 'idle') return;
      updateJob(job.id, (entry) => ({
        ...entry,
        strokes: [],
        sketch: sketchOver(element),
        anchor: element,
      }));
      store.set({ anchor: element });
    },

    undoSketch: () => editSketch(undoStroke),

    redoSketch: () => editSketch(redoStroke),

    setPrompt(prompt: string): void {
      const job = focused();
      if (job) setGeneration(job.id, { ...job.generation, prompt });
    },

    generate: async () => {
      const job = focused();
      if (!job) return;
      if (hasUnsaved()) await revert('Unsaved tweaks were reverted.');
      await run(job.id, false);
    },

    async askForVariations(): Promise<void> {
      const job = focused();
      if (!job) return;
      await settle(job);
      setGeneration(job.id, { ...IDLE_GENERATION, prompt: job.generation.prompt });
      await run(job.id, true);
    },

    async askAnother(): Promise<void> {
      const job = focused();
      if (!job) return;
      await settle(job);
      setGeneration(job.id, IDLE_GENERATION);
    },

    async cancelGeneration(): Promise<void> {
      const job = focused();
      if (job?.generation.status !== 'running') return;
      setGeneration(job.id, { ...IDLE_GENERATION, prompt: job.generation.prompt });
      await settle(job);
    },

    async selectVariant(index: number): Promise<void> {
      const job = focused();
      if (!job || index === job.generation.active) return;
      const { status, variants } = job.generation;
      if (status !== 'ready' && !(status === 'running' && variants.length > 0)) return;
      await showVariant(job.id, index);
    },

    async editPrompt(): Promise<void> {
      const job = focused();
      if (!job) return;
      await settle(job);
      updateJob(job.id, (entry) => ({
        ...entry,
        previewed: false,
        generation: { ...IDLE_GENERATION, prompt: job.generation.prompt },
      }));
    },

    async attach(files: readonly File[]): Promise<void> {
      const job = focused();
      if (!job || job.generation.status === 'running' || files.length === 0) return;
      const room = roomFor(job.attachments.length, files.length);
      const problems: string[] = [];
      const added: Attachment[] = [];
      for (const file of files.slice(0, room)) {
        const check = checkSource(file.name, file.type, file.size);
        if (!check.ok) {
          problems.push(check.reason);
          continue;
        }
        try {
          added.push(await prepareImage(file));
        } catch (error) {
          problems.push(error instanceof Error ? error.message : String(error));
        }
      }
      const overflow = overflowNote(files.length - room);
      if (overflow) problems.push(overflow);
      updateJob(job.id, (entry) => ({
        ...entry,
        attachments: [...entry.attachments, ...added].slice(0, MAX_ATTACHMENTS),
        attachError: problems.length > 0 ? problems.join(' ') : null,
      }));
    },

    removeAttachment(id: string): void {
      const job = focused();
      if (!job || job.generation.status === 'running') return;
      updateJob(job.id, (entry) => ({
        ...entry,
        attachments: entry.attachments.filter((attachment) => attachment.id !== id),
        attachError: null,
      }));
    },

    async restore(saved: Saved): Promise<void> {
      if (store.get().jobs.length > 0) return;
      const jobs = saved.jobs.map((job) => {
        const element = elementsAt(job.target.src)[0];
        return {
          ...job,
          generation: { ...IDLE_GENERATION, ...job.generation },
          anchor: job.sketch ? sketchAnchor(job.sketch) : element ? rectOf(element) : job.anchor,
        };
      });
      store.set({ jobs });
      for (const job of jobs) {
        if (job.generation.status === 'running' && job.generation.runId) {
          void reattach(job.id, job.generation.runId);
        }
      }
      const shown = jobs.find((job) => job.previewed && job.generation.status === 'ready');
      if (shown) await reshow(shown);
      if (saved.focus) await focusJob(saved.focus);
    },

    async installDependencies(): Promise<void> {
      const job = focused();
      const variant = job?.generation.variants[job.generation.active];
      const runId = job?.generation.runId;
      if (!job || !variant?.needs || !runId || job.installing) return;
      updateJob(job.id, (entry) => ({ ...entry, installing: true, installError: null }));
      const reply = await host.request({
        type: 'dependencies.install',
        payload: { runId, changesetId: variant.changesetId },
      });
      if (reply.type !== 'dependencies.installed') {
        const problem = failure(reply);
        updateJob(job.id, (entry) => ({
          ...entry,
          installing: false,
          installError: [problem.message, problem.action].filter(Boolean).join(' '),
        }));
        return;
      }
      const installed = new Set(reply.payload.installed.map((entry) => entry.name));
      store.set({
        jobs: store.get().jobs.map((entry) =>
          entry.id === job.id
            ? {
                ...entry,
                installing: false,
                previewed: true,
                generation: {
                  ...entry.generation,
                  variants: entry.generation.variants.map((option) =>
                    withoutInstalled(option, installed),
                  ),
                },
              }
            : { ...entry, previewed: false },
        ),
      });
    },

    async discardJob(): Promise<void> {
      const job = focused();
      if (!job) return;
      const shown = job.generation.variants.length;
      removeJob(job.id);
      clearPanel();
      await settle(job);
      if (shown > 0) {
        notify({
          kind: 'info',
          message: shown > 1 ? 'The variants were discarded.' : 'The variant was discarded.',
        });
      }
    },

    async commitVariant(): Promise<void> {
      const job = focused();
      const variant = job?.generation.variants[job.generation.active];
      if (!job || !variant) return;
      store.set({ busy: true });
      const reply = await host.request({
        type: 'changeset.commit',
        payload: { changesetId: variant.changesetId },
      });
      if (reply.type !== 'commit.done') {
        store.set({ busy: false });
        updateJob(job.id, (entry) => ({
          ...entry,
          previewed: false,
          generation: { ...IDLE_GENERATION, prompt: job.generation.prompt },
        }));
        notify(failure(reply), UNDO_WINDOW_MS);
        return;
      }
      const { target } = job;
      const own = changesIn(target.file, variant.changes);
      committed.set(reply.payload.journalId, own);
      const { runId: stillRunning, status } = job.generation;
      if (status === 'running' && stillRunning) {
        runs.delete(stillRunning);
        void host.request({ type: 'generate.cancel', payload: { runId: stillRunning } });
      }
      const moveTarget = (selection: Selection): Selection => {
        if (selection.file !== target.file) return selection;
        const line = shiftedLine(selection.line, own);
        return { ...selection, line, src: `${selection.file}:${line}:${selection.column}` };
      };
      removeJob(job.id);
      store.set({
        jobs: store.get().jobs.map((entry) => ({
          ...entry,
          previewed: false,
          target: moveTarget(entry.target),
          also: entry.also.map(moveTarget),
        })),
      });
      const moved = moveTarget(target);
      const element = elementsAt(moved.src)[0];
      const applied = withTicketNote(
        {
          kind: 'info' as const,
          message: appliedMessage(editedFiles(variant)),
          undoJournalId: reply.payload.journalId,
        },
        job.ticket,
      );
      if (job.ticket) postToTicket(job.ticket, reply.payload.journalId, moved.src);
      if (!element) {
        store.set({ busy: false });
        clearPanel();
        notify(applied, UNDO_WINDOW_MS);
        return;
      }
      store.set({
        busy: false,
        focus: null,
        mode: 'finetune',
        selection: moved,
        anchor: rectOf(element),
        group: [],
        style: null,
        current: readCurrent(element),
        selectionGone: false,
      });
      notify(applied, UNDO_WINDOW_MS);
      await inspect(moved, true);
    },

    hover(element: Element | null): void {
      store.set({ hovered: element ? rectOf(element) : null });
    },

    edit(change: Draft): void {
      setDraft({ ...store.get().draft, ...change });
    },

    editText(run: number, value: string): void {
      const { draft, style } = store.get();
      const original = style?.content?.find((part) => part.kind === 'text' && part.run === run);
      const { content: drafted, ...rest } = draft;
      const content = { ...drafted };
      if (original?.kind === 'text' && original.value === value) delete content[run];
      else content[run] = value;
      const next: Draft = Object.keys(content).length > 0 ? { ...rest, content } : rest;
      if (Object.keys(next).length === 0) {
        void revert();
        return;
      }
      setDraft(next);
    },

    editSource(place: TextPlace, value: string): void {
      const { draft, style } = store.get();
      const found = style?.content?.find((part) => part.kind === 'found');
      const { source: _, ...rest } = draft;
      const next: Draft =
        found?.kind === 'found' && found.value === value
          ? rest
          : { ...rest, source: { place, value } };
      if (Object.keys(next).length === 0) {
        void revert();
        return;
      }
      setDraft(next);
    },

    async apply(): Promise<void> {
      const { selection } = store.get();
      if (!selection) return;
      if (previewTimer) {
        clearTimeout(previewTimer);
        previewTimer = undefined;
        previewing = preview(editSequence);
      }
      await previewing;
      const { preview: pending } = store.get();
      if (!pending) return;
      store.set({ busy: true });
      const reply = await host.request({
        type: 'changeset.commit',
        payload: { changesetId: pending.changesetId },
      });
      store.set({ busy: false, draft: {}, preview: null });
      if (reply.type !== 'commit.done') {
        domPreview.revert();
        notify(failure(reply), UNDO_WINDOW_MS);
        await inspect(selection);
        return;
      }
      domPreview.keep();
      const { ticket: linked } = ticketTarget();
      notify(
        withTicketNote(
          {
            kind: 'info',
            message: appliedMessage(
              reply.payload.files.length > 0 ? reply.payload.files : [selection.file],
            ),
            undoJournalId: reply.payload.journalId,
          },
          linked,
        ),
        UNDO_WINDOW_MS,
      );
      if (linked) postToTicket(linked, reply.payload.journalId, selection.src);
      const job = focused();
      if (job) {
        removeJob(job.id);
        clearPanel();
        return;
      }
      await inspect(selection, true);
    },

    revert: () => revert(),

    async undo(journalId: string): Promise<void> {
      const reply = await host.request({ type: 'journal.undo', payload: { journalId } });
      if (reply.type !== 'undo.done') {
        notify(failure(reply), UNDO_WINDOW_MS);
        return;
      }
      notify({ kind: 'info', message: 'Change undone.' });
      const { selection, style } = store.get();
      if (!selection) return;
      if (style?.content?.some((part) => part.kind === 'found')) {
        await textChanged(elementsAt(selection.src)[selection.instance ?? 0]);
      }
      const changes = committed.get(journalId);
      committed.delete(journalId);
      const line = changes ? shiftedLine(selection.line, invertChanges(changes)) : selection.line;
      const moved: Selection = {
        ...selection,
        line,
        src: `${selection.file}:${line}:${selection.column}`,
      };
      store.set({ selection: moved });
      await inspect(moved, true);
    },

    async close(): Promise<void> {
      const job = focused();
      if (!job) {
        await revert(hasUnsaved() ? 'Unsaved tweaks were reverted.' : undefined);
        clearPanel();
        return;
      }
      if (hasUnsaved()) await revert('Unsaved tweaks were reverted.');
      const draft = job.generation.status === 'idle' && job.generation.variants.length === 0;
      if (!draft) {
        clearPanel();
        return;
      }
      removeJob(job.id);
      const back = jobById(previousFocus);
      previousFocus = null;
      if (back) await focusJob(back.id);
      else clearPanel();
    },

    dismissNotice: () => notify(null),

    reanchor(): void {
      const { jobs, selection } = store.get();
      const moved = jobs.map((job) => {
        const element = job.sketch ? undefined : elementsAt(job.target.src)[0];
        if (!element) return job;
        const anchor = rectOf(element);
        const same = anchor.left === job.anchor.left && anchor.top === job.anchor.top;
        return same ? job : { ...job, anchor };
      });
      if (moved.some((job, index) => job !== jobs[index])) store.set({ jobs: moved });
      const job = focused();
      if (job && job.also.length > 0) store.set({ group: groupRects(job.also) });
      if (job?.sketch) return;
      const element = selection ? elementsAt(selection.src)[0] : undefined;
      if (element) store.set({ anchor: rectOf(element) });
    },
  };
  return controllerApi;
}
