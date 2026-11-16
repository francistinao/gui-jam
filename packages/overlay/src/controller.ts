import type {
  CodeChange,
  ElementStyle,
  FillValue,
  GenerateDone,
  GenerateProgress,
  GuijamMessage,
  RadiusValue,
  Route,
  VariantPreview,
} from '@guijam/contracts-ts';
import type { WidgetHost } from './host';
import {
  chooseDrawTarget,
  cssColor,
  type HexColor,
  hexOfComputedColor,
  type Rect,
  samplePoints,
  type Tool,
} from './model';
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
};

export interface WidgetState {
  tool: Tool | null;
  mode: PanelMode;
  generation: Generation;
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
  mode: 'finetune',
  generation: IDLE_GENERATION,
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

function elementUnder(stroke: Rect): Element | null {
  const found = new Set<Element>();
  for (const { x, y } of samplePoints(stroke)) {
    for (const element of document.elementsFromPoint(x, y)) {
      if (element.hasAttribute(SRC_ATTRIBUTE)) found.add(element);
    }
  }
  const candidates = [...found];
  const index = chooseDrawTarget(stroke, candidates.map(rectOf));
  return index === null ? null : (candidates[index] ?? null);
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
  let runId: string | null = null;
  let selectSequence = 0;
  const styled = new Set<HTMLElement>();

  host.onEvent((message) => {
    if (message.type !== 'generate.progress' || message.payload.runId !== runId) return;
    const { generation } = store.get();
    store.set({ generation: { ...generation, steps: message.payload.steps } });
  });

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

  async function settleGeneration(): Promise<void> {
    const { generation } = store.get();
    if (runId) {
      const cancelled = runId;
      runId = null;
      void host.request({ type: 'generate.cancel', payload: { runId: cancelled } });
    }
    store.set({ generation: { ...IDLE_GENERATION, prompt: generation.prompt } });
    if (generation.status === 'ready' && generation.runId) {
      await host.request({ type: 'generate.discard', payload: { runId: generation.runId } });
    }
  }

  async function run(forceAi: boolean): Promise<void> {
    const { selection, generation } = store.get();
    const prompt = generation.prompt.trim();
    if (!selection || !prompt || generation.status !== 'idle') return;
    const id = crypto.randomUUID();
    runId = id;
    store.set({ generation: { ...IDLE_GENERATION, prompt, status: 'running', runId: id } });
    const reply = await host.request({
      type: 'generate.request',
      payload: {
        runId: id,
        file: selection.file,
        line: selection.line,
        column: selection.column,
        prompt,
        ...(forceAi ? { forceAi } : {}),
      },
    });
    if (runId !== id) {
      if (reply.type === 'generate.done') {
        void host.request({ type: 'generate.discard', payload: { runId: id } });
      }
      return;
    }
    runId = null;
    const latest = store.get().generation;
    if (reply.type !== 'generate.done') {
      store.set({
        generation: { ...IDLE_GENERATION, prompt: latest.prompt, error: failure(reply) },
      });
      return;
    }
    const { variants, dropped, route, elapsedMs, answer } = reply.payload;
    store.set({
      generation: {
        ...latest,
        status: 'ready',
        variants: [...variants],
        active: 0,
        dropped,
        route,
        elapsedMs,
        answer: answer ?? null,
      },
    });
  }

  async function open(element: Element, mode: PanelMode): Promise<void> {
    const src = element.getAttribute(SRC_ATTRIBUTE);
    const parsed = src === null ? null : parseSrc(src);
    if (!parsed) return;
    if (hasUnsaved()) await revert('Unsaved tweaks were reverted.');
    await settleGeneration();
    const selection: Selection = { ...parsed, instances: elementsAt(parsed.src).length };
    store.set({
      selection,
      mode,
      generation: IDLE_GENERATION,
      anchor: rectOf(element),
      style: null,
      current: readCurrent(element),
      draft: {},
      preview: null,
    });
    await inspect(selection);
  }

  return {
    select: (element: Element) => open(element, 'finetune'),

    async draw(stroke: Rect): Promise<boolean> {
      const element = elementUnder(stroke);
      if (!element) {
        notify({ kind: 'info', message: 'Nothing editable under that mark.' });
        return false;
      }
      await open(element, 'prompt');
      return true;
    },

    async askAI(): Promise<void> {
      await revert(hasUnsaved() ? 'Unsaved tweaks were reverted.' : undefined);
      store.set({ mode: 'prompt' });
    },

    setPrompt(prompt: string): void {
      store.set({ generation: { ...store.get().generation, prompt } });
    },

    generate: () => run(false),

    async askForVariations(): Promise<void> {
      await settleGeneration();
      await run(true);
    },

    async askAnother(): Promise<void> {
      await settleGeneration();
      store.set({ generation: IDLE_GENERATION });
    },

    async cancelGeneration(): Promise<void> {
      if (!runId) return;
      const cancelled = runId;
      runId = null;
      store.set({ generation: { ...IDLE_GENERATION, prompt: store.get().generation.prompt } });
      await host.request({ type: 'generate.cancel', payload: { runId: cancelled } });
    },

    async selectVariant(index: number): Promise<void> {
      const { generation } = store.get();
      const variant = generation.variants[index];
      if (generation.status !== 'ready' || !generation.runId || !variant) return;
      if (index === generation.active) return;
      selectSequence += 1;
      const sequence = selectSequence;
      store.set({ generation: { ...generation, active: index } });
      const reply = await host.request({
        type: 'variant.select',
        payload: { runId: generation.runId, changesetId: variant.changesetId },
      });
      if (sequence === selectSequence && reply.type !== 'variant.selected') {
        notify(failure(reply), UNDO_WINDOW_MS);
      }
    },

    editPrompt: () => settleGeneration(),

    async commitVariant(): Promise<void> {
      const { selection, generation } = store.get();
      const variant = generation.variants[generation.active];
      if (!selection || !variant) return;
      store.set({ busy: true });
      const reply = await host.request({
        type: 'changeset.commit',
        payload: { changesetId: variant.changesetId },
      });
      if (reply.type !== 'commit.done') {
        store.set({ busy: false, generation: { ...IDLE_GENERATION, prompt: generation.prompt } });
        notify(failure(reply), UNDO_WINDOW_MS);
        return;
      }
      const element = elementsAt(selection.src)[0];
      store.set({
        busy: false,
        mode: 'finetune',
        generation: IDLE_GENERATION,
        style: null,
        current: element ? readCurrent(element) : null,
      });
      notify(
        { kind: 'info', message: appliedTo(selection), undoJournalId: reply.payload.journalId },
        UNDO_WINDOW_MS,
      );
      await inspect(selection);
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
      if (selection) await inspect(selection);
    },

    async close(): Promise<void> {
      const shown = store.get().generation.variants.length;
      const notice = hasUnsaved()
        ? 'Unsaved tweaks were reverted.'
        : shown > 1
          ? 'The variants were discarded.'
          : shown === 1
            ? 'The variant was discarded.'
            : undefined;
      await settleGeneration();
      await revert(notice);
      store.set({
        selection: null,
        anchor: null,
        style: null,
        current: null,
        mode: 'finetune',
        generation: IDLE_GENERATION,
      });
    },

    dismissNotice: () => notify(null),

    reanchor(): void {
      const { selection } = store.get();
      const element = selection ? elementsAt(selection.src)[0] : undefined;
      if (element) store.set({ anchor: rectOf(element) });
    },
  };
}
