import type { ElementStyle, StyleGroup, StyleToken } from '@guijam/contracts-ts';
import { Pencil } from 'lucide-react';
import type { ReactNode } from 'react';
import { ContentEditor, hasTextContent } from './ContentEditor';
import type { Controller, Draft, WidgetState } from './controller';
import { Button } from './figui/button';
import { InputGroup, InputGroupAddon } from './figui/input-group';
import { NumericInput, NumericInputRoot, NumericScrubArea } from './figui/numeric-input';
import { Tab, Tabs, TabsList, TabsPanel } from './figui/tabs';
import {
  type Current,
  clamp,
  fillOfToken,
  GROUP_LABELS,
  type PanelSection,
  panelSections,
  parseHex,
  RADIUS_RANGE,
  radiusOfToken,
} from './model';
import { CodeChanges, Popover, PopoverHeader, SKETCH_LABEL } from './Popover';
import {
  ColorField,
  type EditorProps,
  EffectsEditor,
  LayoutEditor,
  OpacityEditor,
  otherTokens,
  StrokeEditor,
  TextEditor,
} from './StyleEditors';
import { type Store, useStore } from './store';
import { TicketField } from './TicketField';

const DEFAULT_RADIUS_PX = 8;
const DEFAULT_FILL = '#FFFFFF';

interface PanelProps {
  store: Store<WidgetState>;
  controller: Controller;
}

function baseToken(tokens: readonly StyleToken[]): StyleToken | undefined {
  return tokens.find((token) => token.editable) ?? tokens[0];
}

function RadiusEditor({ style, draft, current, controller }: EditorProps) {
  const base = baseToken(style.tokens.filter((token) => token.group === 'radius'));
  const radius = draft.radius;
  const px =
    radius?.kind === 'px'
      ? radius.px
      : radius?.kind === 'token'
        ? (style.theme.radii.find((entry) => entry.name === radius.name)?.px ?? null)
        : radius?.kind === 'full'
          ? null
          : (radiusOfToken(base) ?? current?.radiusPx ?? null);
  const tokenLabel =
    radius === undefined
      ? base?.themeToken
      : radius.kind === 'px'
        ? undefined
        : radius.kind === 'full'
          ? 'full'
          : radius.name;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <InputGroup className="w-28">
          <NumericInputRoot
            value={px}
            min={RADIUS_RANGE.min}
            max={RADIUS_RANGE.max}
            onValueChange={(next) => {
              if (next !== null) {
                controller.edit({
                  radius: { kind: 'px', px: clamp(Math.round(next), RADIUS_RANGE) },
                });
              }
            }}
          >
            <NumericScrubArea>
              <InputGroupAddon>⌜</InputGroupAddon>
            </NumericScrubArea>
            <NumericInput aria-label="Corner radius" />
          </NumericInputRoot>
        </InputGroup>
        {tokenLabel ? (
          <span className="typography-body-medium text-grey-500">{tokenLabel}</span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1">
        {style.theme.radii.map((entry) => (
          <Button
            key={entry.name}
            variant="ghost"
            aria-label={`Radius ${entry.name}`}
            aria-pressed={tokenLabel === entry.name}
            className="aria-pressed:bg-blue-100 aria-pressed:text-blue-800"
            onClick={() => controller.edit({ radius: { kind: 'token', name: entry.name } })}
          >
            {entry.name}
          </Button>
        ))}
        <Button
          variant="ghost"
          aria-label="Radius full"
          aria-pressed={tokenLabel === 'full'}
          className="aria-pressed:bg-blue-100 aria-pressed:text-blue-800"
          onClick={() => controller.edit({ radius: { kind: 'full' } })}
        >
          full
        </Button>
      </div>
    </div>
  );
}

function FillEditor({ style, draft, current, controller }: EditorProps) {
  const fill = draft.fill;
  const base = baseToken(style.tokens.filter((token) => token.group === 'fill'));
  const shown = fillOfToken(base) ?? current?.fill ?? null;
  const themeValue = (name: string) =>
    parseHex(style.theme.colors.find((color) => color.name === name)?.value ?? '');
  const hex =
    fill?.kind === 'hex'
      ? fill.hex
      : fill?.kind === 'token'
        ? (themeValue(fill.name) ?? DEFAULT_FILL)
        : (shown?.hex ?? DEFAULT_FILL);
  const opacity = fill?.kind === 'hex' ? fill.opacity : (shown?.opacity ?? 100);
  const tokenLabel =
    fill === undefined ? base?.themeToken : fill.kind === 'token' ? fill.name : undefined;
  return (
    <div className="flex flex-col gap-2">
      <ColorField
        label="Fill"
        style={style}
        color={{ hex, opacity }}
        token={tokenLabel}
        removed={fill?.kind === 'none'}
        onChange={(next) => controller.edit({ fill: next })}
        onRemove={() => controller.edit({ fill: { kind: 'none' } })}
      />
      {style.theme.colors.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {style.theme.colors.map((color) => (
            <button
              key={color.name}
              type="button"
              aria-label={`Fill ${color.name}`}
              aria-pressed={tokenLabel === color.name}
              title={color.name}
              className="size-5 rounded-sm inset-ring inset-ring-black-200 aria-pressed:ring-2 aria-pressed:ring-blue-500"
              style={{ backgroundColor: color.value }}
              onClick={() => controller.edit({ fill: { kind: 'token', name: color.name } })}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const EDITORS: Record<StyleGroup, (props: EditorProps) => ReactNode> = {
  layout: LayoutEditor,
  radius: RadiusEditor,
  fill: FillEditor,
  stroke: StrokeEditor,
  text: TextEditor,
  effects: EffectsEditor,
  opacity: OpacityEditor,
};

function added(group: StyleGroup, style: ElementStyle, current: Current | null): Draft {
  switch (group) {
    case 'fill':
      return { fill: { kind: 'hex', hex: current?.fill?.hex ?? DEFAULT_FILL, opacity: 100 } };
    case 'radius':
      return { radius: { kind: 'px', px: current?.radiusPx || DEFAULT_RADIUS_PX } };
    case 'stroke':
      return {
        stroke: {
          kind: 'set',
          width: 1,
          style: 'solid',
          color: { kind: 'hex', hex: '#000000', opacity: 100 },
        },
      };
    case 'effects':
      return {
        effects: {
          drop: style.theme.shadows.some((entry) => entry.name === 'sm' && !entry.inset)
            ? { kind: 'token', name: 'sm' }
            : { kind: 'custom', x: 0, y: 4, blur: 8, spread: 0, hex: '#000000', opacity: 20 },
        },
      };
    default:
      return {};
  }
}

function Section({
  section,
  style,
  draft,
  current,
  controller,
}: {
  section: PanelSection;
  style: ElementStyle;
  draft: Draft;
  current: Current | null;
  controller: Controller;
}) {
  const label = GROUP_LABELS[section.group];
  const drafted = section.group in draft && draft[section.group as keyof Draft] !== undefined;
  if (section.mode === 'readonly') {
    return (
      <section aria-label={label} className="flex items-start gap-3 py-2">
        <h3 className="typography-body-medium w-14 shrink-0 font-[500]">{label}</h3>
        <code className="typography-body-small break-all text-grey-500">
          {section.tokens.map((token) => token.token).join(' ')}
        </code>
      </section>
    );
  }
  if (section.mode === 'add' && !drafted) {
    return (
      <section aria-label={label} className="flex items-center justify-between py-2">
        <h3 className="typography-body-medium font-[500]">{label}</h3>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Add ${label.toLowerCase()}`}
          onClick={() => controller.edit(added(section.group, style, current))}
        >
          +
        </Button>
      </section>
    );
  }
  const Editor = EDITORS[section.group];
  const others = otherTokens(style, section.group);
  return (
    <section aria-label={label} className="flex flex-col gap-2 py-2">
      <h3 className="typography-body-medium font-[500]">{label}</h3>
      <Editor style={style} draft={draft} current={current} controller={controller} />
      {others.length > 0 ? (
        <code className="typography-body-small break-all text-grey-500">
          {others.map((token) => token.token).join(' ')}
        </code>
      ) : null}
    </section>
  );
}

export function FinetunePanel({ store, controller }: PanelProps) {
  const selection = useStore(store, (state) => state.selection);
  const anchor = useStore(store, (state) => state.anchor);
  const style = useStore(store, (state) => state.style);
  const current = useStore(store, (state) => state.current);
  const draft = useStore(store, (state) => state.draft);
  const preview = useStore(store, (state) => state.preview);
  const busy = useStore(store, (state) => state.busy);
  const ticket = useStore(store, (state) => state.ticket);
  const panelAt = useStore(store, (state) => state.panelAt);

  if (!selection || !anchor) return null;
  const unsaved = preview !== null || Object.keys(draft).length > 0;
  const sections = style ? panelSections(style) : [];

  return (
    <Popover
      label={`Fine-tune ${selection.file}`}
      anchor={anchor}
      at={panelAt}
      onMove={controller.movePanel}
    >
      <PopoverHeader
        tag={style?.tag}
        badge="Fine-tune"
        selection={selection}
        controller={controller}
      >
        <Button variant="ghost" onClick={() => void controller.askAI()}>
          Ask AI
        </Button>
      </PopoverHeader>
      <Button
        variant="secondary"
        size="large"
        className="mb-2 w-full cursor-pointer transition-colors hover:border-blue-500 hover:bg-blue-200 hover:text-blue-800 active:border-blue-500 active:bg-blue-300"
        disabled={busy}
        onClick={() => void controller.startSketch()}
      >
        <Pencil aria-hidden="true" />
        {SKETCH_LABEL}
      </Button>
      <p className="typography-body-small mb-2 text-grey-500">
        Shift+click to add more components to one Ask AI prompt.
      </p>
      <TicketField
        store={store}
        controller={controller}
        ticket={ticket}
        prompt={false}
        report={true}
      />
      {selection.instances > 1 ? (
        <p
          role="note"
          className="typography-body-small mb-2 rounded-md bg-blue-100 p-2 text-blue-800"
        >
          {style?.content?.some((part) => part.kind === 'found')
            ? `Used ${selection.instances}× on this page. Style changes apply to every instance.`
            : `Used ${selection.instances}× on this page. Changes apply to every instance.`}
        </p>
      ) : null}
      <Tabs defaultValue="design">
        <TabsList>
          <Tab value="design">Design</Tab>
          <Tab value="code">Code</Tab>
        </TabsList>
        <TabsPanel value="design" className="divide-y divide-grey-100">
          {style?.content && hasTextContent(style.content) ? (
            <ContentEditor parts={style.content} draft={draft} controller={controller} />
          ) : null}
          {!style ? (
            <p className="typography-body-medium py-3 text-grey-500">Reading the element…</p>
          ) : sections.length === 0 ? (
            <p className="typography-body-medium py-3 text-grey-500">
              This className is computed at runtime, so it can only be changed with Ask AI.
            </p>
          ) : (
            sections.map((section) => (
              <Section
                key={section.group}
                section={section}
                style={style}
                draft={draft}
                current={current}
                controller={controller}
              />
            ))
          )}
        </TabsPanel>
        <TabsPanel value="code">
          <CodeChanges changes={preview?.changes ?? []} />
        </TabsPanel>
      </Tabs>
      <footer className="flex items-center justify-end gap-2 pt-3">
        <div className="mr-auto flex items-center gap-2">
          <Button
            variant="ghost"
            disabled={!style}
            title="Copy style (Alt+Shift+C)"
            onClick={() => controller.copyStyle()}
          >
            Copy style
          </Button>
          {unsaved ? <span className="typography-body-small text-orange-600">Unsaved</span> : null}
        </div>
        <Button
          variant="secondary"
          disabled={!unsaved || busy}
          onClick={() => void controller.revert()}
        >
          Revert
        </Button>
        <Button disabled={preview === null || busy} onClick={() => void controller.apply()}>
          Apply
        </Button>
      </footer>
    </Popover>
  );
}
