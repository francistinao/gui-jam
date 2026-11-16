import type { ElementStyle, StyleGroup, StyleToken } from '@guijam/contracts-ts';
import { Minus } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Controller, Draft, WidgetState } from './controller';
import { Button } from './figui/button';
import { ColorChit } from './figui/color-chit';
import { InputGroup, InputGroupAddon } from './figui/input-group';
import { NumericInput, NumericInputRoot, NumericScrubArea } from './figui/numeric-input';
import { Tab, Tabs, TabsList, TabsPanel } from './figui/tabs';
import { TextInput } from './figui/text-input';
import {
  clamp,
  fillOfToken,
  OPACITY_RANGE,
  type PanelSection,
  panelSections,
  parseHex,
  RADIUS_RANGE,
  radiusOfToken,
} from './model';
import { CodeChanges, Popover, PopoverHeader } from './Popover';
import { type Store, useStore } from './store';

const GROUP_LABELS: Record<StyleGroup, string> = {
  radius: 'Radius',
  fill: 'Fill',
  stroke: 'Stroke',
  text: 'Text',
  effects: 'Effects',
  opacity: 'Opacity',
};
const DEFAULT_RADIUS_PX = 8;
const DEFAULT_FILL = '#FFFFFF';

interface PanelProps {
  store: Store<WidgetState>;
  controller: Controller;
}

function baseToken(tokens: readonly StyleToken[]): StyleToken | undefined {
  return tokens.find((token) => token.editable) ?? tokens[0];
}

function HexField({ value, onCommit }: { value: string; onCommit(hex: string): void }) {
  const [text, setText] = useState(value.slice(1));
  useEffect(() => setText(value.slice(1)), [value]);
  return (
    <TextInput
      aria-label="Fill hex"
      value={text}
      className="w-16 uppercase"
      onChange={(event) => {
        setText(event.target.value);
        const hex = parseHex(event.target.value);
        if (hex) onCommit(hex);
      }}
      onBlur={() => {
        if (!parseHex(text)) setText(value.slice(1));
      }}
    />
  );
}

function RadiusEditor({
  style,
  draft,
  current,
  controller,
}: {
  style: ElementStyle;
  draft: Draft;
  current: WidgetState['current'];
  controller: Controller;
}) {
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

function FillEditor({
  style,
  draft,
  current,
  controller,
}: {
  style: ElementStyle;
  draft: Draft;
  current: WidgetState['current'];
  controller: Controller;
}) {
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
  const removed = fill?.kind === 'none';
  const tokenLabel =
    fill === undefined ? base?.themeToken : fill.kind === 'token' ? fill.name : undefined;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <InputGroup className={removed ? 'opacity-50' : undefined}>
          <InputGroupAddon>
            <ColorChit color={hex} opacity={opacity} />
          </InputGroupAddon>
          <HexField
            value={hex}
            onCommit={(next) => controller.edit({ fill: { kind: 'hex', hex: next, opacity } })}
          />
          <NumericInputRoot
            value={opacity}
            min={OPACITY_RANGE.min}
            max={OPACITY_RANGE.max}
            onValueChange={(next) => {
              if (next !== null) {
                controller.edit({
                  fill: { kind: 'hex', hex, opacity: clamp(Math.round(next), OPACITY_RANGE) },
                });
              }
            }}
          >
            <NumericInput aria-label="Fill opacity" className="w-9" />
          </NumericInputRoot>
          <InputGroupAddon>%</InputGroupAddon>
        </InputGroup>
        {tokenLabel ? (
          <span className="typography-body-medium text-grey-500">{tokenLabel}</span>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Remove fill"
          onClick={() => controller.edit({ fill: { kind: 'none' } })}
        >
          <Minus aria-hidden="true" />
        </Button>
      </div>
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
  current: WidgetState['current'];
  controller: Controller;
}) {
  const label = GROUP_LABELS[section.group];
  const drafted =
    (section.group === 'fill' && draft.fill) || (section.group === 'radius' && draft.radius);
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
          onClick={() =>
            controller.edit(
              section.group === 'fill'
                ? { fill: { kind: 'hex', hex: current?.fill?.hex ?? DEFAULT_FILL, opacity: 100 } }
                : { radius: { kind: 'px', px: current?.radiusPx || DEFAULT_RADIUS_PX } },
            )
          }
        >
          +
        </Button>
      </section>
    );
  }
  const Editor = section.group === 'fill' ? FillEditor : RadiusEditor;
  return (
    <section aria-label={label} className="flex flex-col gap-2 py-2">
      <h3 className="typography-body-medium font-[500]">{label}</h3>
      <Editor style={style} draft={draft} current={current} controller={controller} />
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

  if (!selection || !anchor) return null;
  const unsaved = preview !== null || Object.keys(draft).length > 0;
  const sections = style ? panelSections(style) : [];

  return (
    <Popover label={`Fine-tune ${selection.file}`} anchor={anchor}>
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
      {selection.instances > 1 ? (
        <p
          role="note"
          className="typography-body-small mb-2 rounded-md bg-blue-100 p-2 text-blue-800"
        >
          {`Used ${selection.instances}× on this page — changes apply to every instance.`}
        </p>
      ) : null}
      <Tabs defaultValue="design">
        <TabsList>
          <Tab value="design">Design</Tab>
          <Tab value="code">Code</Tab>
        </TabsList>
        <TabsPanel value="design" className="divide-y divide-grey-100">
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
        {unsaved ? (
          <span className="typography-body-small mr-auto text-orange-600">Unsaved</span>
        ) : null}
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
