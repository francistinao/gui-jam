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
  VariantPreview,
} from '@guijam/contracts-ts';
import type { WidgetHost } from './host';
import {
  classifyGesture,
  containerIndex,
  cssColor,
  type HexColor,
  hexOfComputedColor,
  intersects,
  invertChanges,
  MAX_JOBS,
  nextJobNumber,
  type Point,
  type Rect,
  samplePoints,
  shiftedLine,
  type Tool,
  unionRect,
} from './model';
import { collectPageOutline } from './page-outline';
import { captureSketch } from './sketch';
import type { Store } from './store';

const PREVIEW_DEBOUNCE_MS = 120;
const UNDO_WINDOW_MS = 10_000;
const NOTICE_MS = 4_000;
const SRC_ATTRIBUTE = 'data-gj-src';

export interface Selection {
  src: string;
  file: string;
  line: number;
  column: number;
  instances: number;
}

export interface Draft {
  fill?: FillValue;
  radius?: RadiusValue;
}

export interface Notice {
  kind: 'info' | 'error';
  message: string;
  action?: string;
  undoJournalId?: string;
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
};

export interface SketchState {
  strokes: Point[][];
  bounds: Rect;
}

export interface Job {
  id: string;
  number: number;
  target: Selection;
  anchor: Rect;
  strokes: Point[][];
  sketch: SketchState | null;
  generation: Generation;
  previewed: boolean;
}

export interface WidgetState {
  tool: Tool | null;
  jobs: Job[];
  focus: string | null;
  mode: PanelMode;
  hovered: Rect | null;
  selection: Selection | null;
  anchor: Rect | null;
  style: ElementStyle | null;
  current: { fill: HexColor | null; radiusPx: number | null } | null;
  draft: Draft;
  preview: { changesetId: string; changes: CodeChange[] } | null;
  busy: boolean;
  notice: Notice | null;
}

export const initialState: WidgetState = {
  tool: null,
  jobs: [],
  focus: null,
  mode: 'finetune',
  hovered: null,
  selection: null,
  anchor: null,
  style: null,
  current: null,
  draft: {},
  preview: null,
  busy: false,
  notice: null,
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

function elementsAt(src: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[${SRC_ATTRIBUTE}="${CSS.escape(src)}"]`)];
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

function appliedTo(selection: Selection): string {
  return `Applied to ${selection.file.split('/').pop() ?? selection.file}.`;
}

export type Controller = ReturnType<typeof createController>;

export function createController(host: WidgetHost, store: Store<WidgetState>) {
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let previewing: Promise<void> | undefined;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let editSequence = 0;
  let selectSequence = 0;
  let previousFocus: string | null = null;
  const runs = new Map<string, string>();
  const committed = new Map<string, CodeChange[]>();
  const styled = new Set<HTMLElement>();

  host.onEvent((message) => {
    if (message.type !== 'generate.progress') return;
    const jobId = runs.get(message.payload.runId);
    if (!jobId) return;
    const { steps, timeoutMs } = message.payload;
    updateJob(jobId, (job) => {
      const before = job.generation.steps.find((step) => step.state === 'active')?.label;
      const after = steps.find((step) => step.state === 'active')?.label;
      const stepSince = before === after ? job.generation.stepSince : Date.now();
      return {
        ...job,
        generation: {
          ...job.generation,
          steps,
          stepSince,
          timeoutMs: timeoutMs ?? job.generation.timeoutMs,
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

  function clearPanel(): void {
    store.set({
      focus: null,
      selection: null,
      anchor: null,
      style: null,
      current: null,
      mode: 'finetune',
    });
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

  async function inspect(selection: Selection): Promise<void> {
    const reply = await host.request({
      type: 'element.inspect',
      payload: { file: selection.file, line: selection.line, column: selection.column },
    });
    if (store.get().selection?.src !== selection.src) return;
    if (reply.type === 'element.style') store.set({ style: reply.payload });
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
        props: draft,
      },
    });
    if (sequence !== editSequence) return;
    if (reply.type !== 'finetune.previewed') {
      clearOptimistic();
      store.set({ preview: null });
      notify(failure(reply));
      return;
    }
    clearOptimistic();
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
    const drawn = job.sketch ? await sketchRequest(job.sketch) : null;
    if (!runs.has(runId)) return;
    const reply = await host.request({
      type: 'generate.request',
      payload: {
        runId,
        file: job.target.file,
        line: job.target.line,
        column: job.target.column,
        prompt,
        page: collectPageOutline(document, host.hostElement),
        ...(drawn ? { sketch: drawn } : {}),
        ...(forceAi ? { forceAi } : {}),
      },
    });
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
            active: 0,
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
    if (reply.type === 'variant.selected') return;
    updateJob(jobId, (entry) => ({ ...entry, previewed: false }));
    if (sequence === selectSequence) notify(failure(reply), UNDO_WINDOW_MS);
  }

  async function sketchRequest(sketch: SketchState): Promise<Sketch> {
    const { bounds } = sketch;
    return {
      images: await captureSketch(sketch.strokes, bounds, host.hostElement),
      box: [
        Math.round(bounds.left),
        Math.round(bounds.top),
        Math.round(bounds.width),
        Math.round(bounds.height),
      ],
      touching: touchedBy(bounds, host.hostElement),
    };
  }

  function selectionOf(element: Element): Selection | null {
    const src = element.getAttribute(SRC_ATTRIBUTE);
    const parsed = src === null ? null : parseSrc(src);
    return parsed ? { ...parsed, instances: elementsAt(parsed.src).length } : null;
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
      style: null,
      current: null,
      draft: {},
      preview: null,
    });
    const { generation } = job;
    if (generation.status === 'ready' && generation.variants.length > 0 && !job.previewed) {
      void showVariant(id, generation.active);
    }
    await inspect(job.target);
  }

  async function addJob(
    target: Selection,
    anchor: Rect,
    strokes: Point[][],
    sketch: SketchState | null,
  ): Promise<void> {
    const { jobs } = store.get();
    const job: Job = {
      id: crypto.randomUUID(),
      number: nextJobNumber(jobs.map((entry) => entry.number)),
      target,
      anchor,
      strokes,
      sketch,
      generation: IDLE_GENERATION,
      previewed: false,
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
      style: null,
      current: readCurrent(element),
      draft: {},
      preview: null,
    });
    await inspect(selection);
  }

  return {
    select: (element: Element) => openFinetune(element),

    focus: (id: string) => focusJob(id),

    async draw(points: Point[], bounds: Rect): Promise<boolean> {
      const job = focused();
      if (job?.sketch && job.generation.status === 'idle') {
        const sketch = {
          strokes: [...job.sketch.strokes, points],
          bounds: unionRect(job.sketch.bounds, bounds),
        };
        updateJob(job.id, (entry) => ({
          ...entry,
          sketch,
          strokes: sketch.strokes,
          anchor: sketch.bounds,
        }));
        store.set({ anchor: sketch.bounds });
        return true;
      }
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
      await addJob(target, bounds, [points], { strokes: [points], bounds });
      return true;
    },

    async askAI(): Promise<void> {
      const { selection, anchor } = store.get();
      await revert(hasUnsaved() ? 'Unsaved tweaks were reverted.' : undefined);
      if (!selection || !anchor || atLimit()) return;
      await addJob(selection, anchor, [], null);
    },

    setPrompt(prompt: string): void {
      const job = focused();
      if (job) setGeneration(job.id, { ...job.generation, prompt });
    },

    generate: async () => {
      const job = focused();
      if (job) await run(job.id, false);
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
      if (job?.generation.status !== 'ready' || index === job.generation.active) return;
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
      committed.set(reply.payload.journalId, variant.changes);
      const { target } = job;
      const moveTarget = (selection: Selection): Selection => {
        if (selection.file !== target.file) return selection;
        const line = shiftedLine(selection.line, variant.changes);
        return { ...selection, line, src: `${selection.file}:${line}:${selection.column}` };
      };
      removeJob(job.id);
      store.set({
        jobs: store
          .get()
          .jobs.map((entry) => ({ ...entry, previewed: false, target: moveTarget(entry.target) })),
      });
      const moved = moveTarget(target);
      const element = elementsAt(moved.src)[0];
      store.set({
        busy: false,
        focus: null,
        mode: 'finetune',
        selection: moved,
        anchor: element ? rectOf(element) : store.get().anchor,
        style: null,
        current: element ? readCurrent(element) : null,
      });
      notify(
        { kind: 'info', message: appliedTo(target), undoJournalId: reply.payload.journalId },
        UNDO_WINDOW_MS,
      );
      await inspect(moved);
    },

    hover(element: Element | null): void {
      store.set({ hovered: element ? rectOf(element) : null });
    },

    edit(change: Draft): void {
      const { selection, draft } = store.get();
      if (!selection) return;
      const next = { ...draft, ...change };
      editSequence += 1;
      const sequence = editSequence;
      store.set({ draft: next });
      applyOptimistic(next, selection);
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        previewTimer = undefined;
        previewing = preview(sequence);
      }, PREVIEW_DEBOUNCE_MS);
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
        notify(failure(reply), UNDO_WINDOW_MS);
        await inspect(selection);
        return;
      }
      notify(
        { kind: 'info', message: appliedTo(selection), undoJournalId: reply.payload.journalId },
        UNDO_WINDOW_MS,
      );
      await inspect(selection);
    },

    revert: () => revert(),

    async undo(journalId: string): Promise<void> {
      const reply = await host.request({ type: 'journal.undo', payload: { journalId } });
      if (reply.type !== 'undo.done') {
        notify(failure(reply), UNDO_WINDOW_MS);
        return;
      }
      notify({ kind: 'info', message: 'Change undone.' });
      const { selection } = store.get();
      if (!selection) return;
      const changes = committed.get(journalId);
      committed.delete(journalId);
      const line = changes ? shiftedLine(selection.line, invertChanges(changes)) : selection.line;
      const moved: Selection = {
        ...selection,
        line,
        src: `${selection.file}:${line}:${selection.column}`,
      };
      store.set({ selection: moved });
      await inspect(moved);
    },

    async close(): Promise<void> {
      const job = focused();
      if (!job) {
        await revert(hasUnsaved() ? 'Unsaved tweaks were reverted.' : undefined);
        clearPanel();
        return;
      }
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
      if (focused()?.sketch) return;
      const element = selection ? elementsAt(selection.src)[0] : undefined;
      if (element) store.set({ anchor: rectOf(element) });
    },
  };
}
