import type {
  EffectsValue,
  ElementStyle,
  FillValue,
  ShadowValue,
  StrokeValue,
  StyleToken,
  TextValue,
} from '@guijam/contracts-ts';
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Minus } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { ColorPicker } from './ColorPicker';
import type { Controller } from './controller';
import { Button } from './figui/button';
import { InputGroup, InputGroupAddon } from './figui/input-group';
import { NumericInput, NumericInputRoot, NumericScrubArea } from './figui/numeric-input';
import { TextInput } from './figui/text-input';
import {
  type Current,
  clamp,
  type Draft,
  effectsBase,
  type HexColor,
  OPACITY_RANGE,
  parseHex,
  parseShadows,
  type Range,
  type Shadow,
  SIDES,
  type Side,
  SPACING_RANGE,
  type TextAlign,
} from './model';

const WEIGHTS: readonly [number, string][] = [
  [100, 'Thin'],
  [200, 'Extra light'],
  [300, 'Light'],
  [400, 'Regular'],
  [500, 'Medium'],
  [600, 'Semibold'],
  [700, 'Bold'],
  [800, 'Extra bold'],
  [900, 'Black'],
];
const ALIGNS: readonly [TextAlign, string, typeof AlignLeft][] = [
  ['left', 'Align left', AlignLeft],
  ['center', 'Align center', AlignCenter],
  ['right', 'Align right', AlignRight],
  ['justify', 'Justify', AlignJustify],
];
const STROKE_STYLES = ['solid', 'dashed', 'dotted'] as const;
const FONT_SIZE_RANGE: Range = { min: 1, max: 999 };
const STROKE_RANGE: Range = { min: 0, max: 999 };
const OFFSET_RANGE: Range = { min: -999, max: 999 };
const BLUR_RANGE: Range = { min: 0, max: 999 };
const LETTER_SPACING_RANGE: Range = { min: -1, max: 1 };
const DEFAULT_SHADOW: Shadow = { x: 0, y: 4, blur: 8, spread: 0, hex: '#000000', opacity: 20 };
const BLACK: HexColor = { hex: '#000000', opacity: 100 };
const SHADOW_PROPERTIES = ['shadow', 'shadow-color', 'inset-shadow', 'inset-shadow-color'];

export interface EditorProps {
  style: ElementStyle;
  draft: Draft;
  current: Current | null;
  controller: Controller;
}

function editableToken(
  style: ElementStyle,
  group: StyleToken['group'],
  property: string,
): StyleToken | undefined {
  return style.tokens.find(
    (token) => token.group === group && token.property === property && token.editable,
  );
}

export function otherTokens(style: ElementStyle, group: StyleToken['group']): StyleToken[] {
  return style.tokens.filter(
    (token) =>
      token.group === group &&
      (!token.editable || (group === 'effects' && !SHADOW_PROPERTIES.includes(token.property))),
  );
}

function HexField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit(hex: string): void;
}) {
  const [text, setText] = useState(value.slice(1));
  useEffect(() => setText(value.slice(1)), [value]);
  return (
    <TextInput
      aria-label={`${label} hex`}
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

export function ColorField({
  label,
  style,
  color,
  token,
  removed = false,
  onChange,
  onRemove,
}: {
  label: string;
  style: ElementStyle;
  color: HexColor;
  token: string | undefined;
  removed?: boolean;
  onChange(fill: FillValue): void;
  onRemove?: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <InputGroup className={removed ? 'opacity-50' : undefined}>
        <InputGroupAddon>
          <ColorPicker
            label={label}
            hex={color.hex}
            opacity={color.opacity}
            colors={style.theme.colors}
            token={token}
            onColor={(hex, opacity) => onChange({ kind: 'hex', hex, opacity })}
            onToken={(name) => onChange({ kind: 'token', name })}
          />
        </InputGroupAddon>
        <HexField
          label={label}
          value={color.hex}
          onCommit={(hex) => onChange({ kind: 'hex', hex, opacity: color.opacity })}
        />
        <NumericInputRoot
          value={color.opacity}
          min={OPACITY_RANGE.min}
          max={OPACITY_RANGE.max}
          onValueChange={(next) => {
            if (next !== null) {
              onChange({
                kind: 'hex',
                hex: color.hex,
                opacity: clamp(Math.round(next), OPACITY_RANGE),
              });
            }
          }}
        >
          <NumericInput aria-label={`${label} opacity`} className="w-9" />
        </NumericInputRoot>
        <InputGroupAddon>%</InputGroupAddon>
      </InputGroup>
      {token ? <span className="typography-body-medium text-grey-500">{token}</span> : null}
      {onRemove ? (
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Remove ${label.toLowerCase()}`}
          onClick={onRemove}
        >
          <Minus aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}

export function NumberField({
  label,
  value,
  range,
  addon,
  unit,
  step = 1,
  places = 0,
  className = 'w-20',
  onChange,
}: {
  label: string;
  value: number | null;
  range: Range;
  addon?: ReactNode;
  unit?: string;
  step?: number;
  places?: number;
  className?: string;
  onChange(value: number): void;
}) {
  const scale = 10 ** places;
  return (
    <InputGroup className={className}>
      <NumericInputRoot
        value={value}
        min={range.min}
        max={range.max}
        nudgeAmount={step}
        onValueChange={(next) => {
          if (next !== null) onChange(clamp(Math.round(next * scale) / scale, range));
        }}
      >
        {addon ? (
          <NumericScrubArea>
            <InputGroupAddon>{addon}</InputGroupAddon>
          </NumericScrubArea>
        ) : null}
        <NumericInput aria-label={label} />
      </NumericInputRoot>
      {unit ? <InputGroupAddon>{unit}</InputGroupAddon> : null}
    </InputGroup>
  );
}

function colorOfFill(fill: FillValue | undefined, style: ElementStyle): HexColor | null {
  if (!fill) return null;
  if (fill.kind === 'hex') return { hex: fill.hex, opacity: fill.opacity };
  if (fill.kind === 'none') return null;
  const hex = parseHex(style.theme.colors.find((entry) => entry.name === fill.name)?.value ?? '');
  return hex ? { hex, opacity: 100 } : null;
}

function tokenName(fill: FillValue | undefined, base: StyleToken | undefined): string | undefined {
  if (fill === undefined) return base?.themeToken;
  return fill.kind === 'token' ? fill.name : undefined;
}

const selectClass =
  'typography-body-medium h-6 rounded-md bg-grey-100 px-1.5 text-black-800 outline-none ring ring-transparent hover:ring-grey-200 focus:ring-blue-500';

export function TextEditor({ style, draft, current, controller }: EditorProps) {
  const text = draft.text ?? {};
  const edit = (change: Partial<TextValue>) => controller.edit({ text: { ...text, ...change } });
  const familyToken = editableToken(style, 'text', 'family');
  const weightToken = editableToken(style, 'text', 'weight');
  const colorToken = editableToken(style, 'text', 'color');
  const family = text.family ?? familyToken?.themeToken ?? '';
  const weight = text.weight ?? Number(weightToken?.value ?? current?.fontWeight ?? 400);
  const align = text.align ?? current?.align ?? 'left';
  const color = colorOfFill(text.color, style) ?? current?.color ?? BLACK;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <select
          aria-label="Font family"
          className={`${selectClass} min-w-0 flex-1`}
          value={family}
          onChange={(event) => edit({ family: event.target.value })}
        >
          {family === '' ? <option value="">Inherited</option> : null}
          {style.theme.fonts.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <select
          aria-label="Font weight"
          className={selectClass}
          value={weight}
          onChange={(event) => edit({ weight: Number(event.target.value) })}
        >
          {WEIGHTS.some(([value]) => value === weight) ? null : (
            <option value={weight}>{weight}</option>
          )}
          {WEIGHTS.map(([value, name]) => (
            <option key={value} value={value}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-2">
        <NumberField
          label="Font size"
          value={text.size ?? current?.fontSize ?? null}
          range={FONT_SIZE_RANGE}
          addon="Aa"
          unit="px"
          places={1}
          onChange={(size) => edit({ size })}
        />
        <NumberField
          label="Line height"
          value={text.lineHeight ?? current?.lineHeight ?? null}
          range={SPACING_RANGE}
          addon="↕"
          unit="px"
          places={1}
          onChange={(lineHeight) => edit({ lineHeight })}
        />
        <NumberField
          label="Letter spacing"
          value={text.letterSpacing ?? current?.letterSpacing ?? 0}
          range={LETTER_SPACING_RANGE}
          addon="↔"
          unit="em"
          step={0.01}
          places={3}
          onChange={(letterSpacing) => edit({ letterSpacing })}
        />
      </div>
      <div className="flex items-center gap-1">
        {ALIGNS.map(([value, label, Icon]) => (
          <Button
            key={value}
            variant="ghost"
            size="icon"
            aria-label={label}
            aria-pressed={align === value}
            className="aria-pressed:bg-blue-100 aria-pressed:text-blue-800"
            onClick={() => edit({ align: value })}
          >
            <Icon aria-hidden="true" />
          </Button>
        ))}
      </div>
      <ColorField
        label="Text"
        style={style}
        color={color}
        token={tokenName(text.color, colorToken)}
        onChange={(next) => edit({ color: next })}
      />
    </div>
  );
}

export function StrokeEditor({ style, draft, current, controller }: EditorProps) {
  const stroke = draft.stroke;
  const removed = stroke?.kind === 'none';
  const set: Extract<StrokeValue, { kind: 'set' }> =
    stroke?.kind === 'set' ? stroke : { kind: 'set' };
  const edit = (change: Partial<Extract<StrokeValue, { kind: 'set' }>>) =>
    controller.edit({ stroke: { ...set, ...change, kind: 'set' } });
  const colorToken = editableToken(style, 'stroke', 'color');
  const widthToken = editableToken(style, 'stroke', 'width');
  const width =
    set.width ?? (widthToken ? Number.parseFloat(widthToken.value ?? '') : null) ?? null;
  const shownWidth = Number.isFinite(width) ? width : (current?.border.width ?? 0);
  const line = set.style ?? editableToken(style, 'stroke', 'style')?.themeToken ?? 'solid';
  const color = colorOfFill(set.color, style) ?? current?.border.color ?? BLACK;
  return (
    <div className="flex flex-col gap-2">
      <ColorField
        label="Stroke"
        style={style}
        color={color}
        removed={removed}
        token={tokenName(set.color, colorToken)}
        onChange={(next) => edit({ color: next })}
        onRemove={() => controller.edit({ stroke: { kind: 'none' } })}
      />
      <div className="flex items-center gap-2">
        <NumberField
          label="Stroke width"
          value={removed ? 0 : shownWidth}
          range={STROKE_RANGE}
          addon="≡"
          unit="px"
          onChange={(next) => edit({ width: next })}
        />
        <div className="flex items-center gap-1">
          {STROKE_STYLES.map((value) => (
            <Button
              key={value}
              variant="ghost"
              aria-label={`Stroke ${value}`}
              aria-pressed={!removed && line === value}
              className="aria-pressed:bg-blue-100 aria-pressed:text-blue-800"
              onClick={() => edit({ style: value })}
            >
              {value}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

function customOf(shadow: ShadowValue, inset: boolean, style: ElementStyle): Shadow {
  if (shadow.kind === 'custom') return shadow;
  if (shadow.kind === 'none') return DEFAULT_SHADOW;
  const value =
    style.theme.shadows.find((entry) => entry.name === shadow.name && entry.inset === inset)
      ?.value ?? '';
  const parsed = parseShadows(value);
  return (inset ? parsed.inner : parsed.drop) ?? DEFAULT_SHADOW;
}

function ShadowBlock({
  kind,
  style,
  drafted,
  base,
  inCode,
  controller,
}: {
  kind: 'drop' | 'inner';
  style: ElementStyle;
  drafted: EffectsValue | undefined;
  base: ShadowValue | undefined;
  inCode: boolean;
  controller: Controller;
}) {
  const inset = kind === 'inner';
  const label = inset ? 'Inner shadow' : 'Drop shadow';
  const wanted = drafted?.[kind];
  const shadow =
    wanted?.kind === 'none'
      ? undefined
      : (wanted ?? base ?? (inCode ? { kind: 'custom' as const, ...DEFAULT_SHADOW } : undefined));
  const set = (next: ShadowValue) => controller.edit({ effects: { ...drafted, [kind]: next } });
  const presets = style.theme.shadows.filter((entry) => entry.inset === inset);
  if (!shadow) {
    return (
      <div className="flex items-center justify-between">
        <span className="typography-body-medium text-grey-500">{label}</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Add ${label.toLowerCase()}`}
          onClick={() =>
            set(
              presets.some((entry) => entry.name === 'sm')
                ? { kind: 'token', name: 'sm' }
                : { kind: 'custom', ...DEFAULT_SHADOW },
            )
          }
        >
          +
        </Button>
      </div>
    );
  }
  const custom = customOf(shadow, inset, style);
  const edit = (change: Partial<Shadow>) => set({ kind: 'custom', ...custom, ...change });
  const offset = (name: 'x' | 'y' | 'blur' | 'spread', text: string, range: Range) => (
    <NumberField
      label={`${label} ${name === 'x' || name === 'y' ? name.toUpperCase() : name}`}
      value={custom[name]}
      range={range}
      addon={text}
      className="w-[72px]"
      onChange={(next) => edit({ [name]: next })}
    />
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="typography-body-medium">{label}</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Remove ${label.toLowerCase()}`}
          onClick={() => set({ kind: 'none' })}
        >
          <Minus aria-hidden="true" />
        </Button>
      </div>
      {presets.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {presets.map((entry) => (
            <Button
              key={entry.name}
              variant="ghost"
              aria-label={`${label} ${entry.name}`}
              aria-pressed={shadow.kind === 'token' && shadow.name === entry.name}
              className="aria-pressed:bg-blue-100 aria-pressed:text-blue-800"
              onClick={() => set({ kind: 'token', name: entry.name })}
            >
              {entry.name}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        {offset('x', 'X', OFFSET_RANGE)}
        {offset('y', 'Y', OFFSET_RANGE)}
        {offset('blur', 'B', BLUR_RANGE)}
        {offset('spread', 'S', OFFSET_RANGE)}
      </div>
      <ColorField
        label={label}
        style={style}
        color={{ hex: custom.hex, opacity: custom.opacity }}
        token={undefined}
        onChange={(next) => {
          const color = colorOfFill(next, style);
          if (color) edit(color);
        }}
      />
    </div>
  );
}

export function EffectsEditor({ style, draft, current, controller }: EditorProps) {
  const base = effectsBase(style, current);
  const coded = (property: string) =>
    style.tokens.some(
      (token) => token.group === 'effects' && token.property === property && token.editable,
    );
  return (
    <div className="flex flex-col gap-3">
      <ShadowBlock
        kind="drop"
        style={style}
        drafted={draft.effects}
        base={base.drop}
        inCode={coded('shadow')}
        controller={controller}
      />
      <ShadowBlock
        kind="inner"
        style={style}
        drafted={draft.effects}
        base={base.inner}
        inCode={coded('inset-shadow')}
        controller={controller}
      />
    </div>
  );
}

export function OpacityEditor({ draft, current, controller }: EditorProps) {
  return (
    <NumberField
      label="Element opacity"
      value={draft.opacity ?? current?.opacity ?? 100}
      range={OPACITY_RANGE}
      addon="◐"
      unit="%"
      onChange={(opacity) => controller.edit({ opacity })}
    />
  );
}

const SIDE_LABELS: Record<Side, string> = {
  top: 'Top padding',
  right: 'Right padding',
  bottom: 'Bottom padding',
  left: 'Left padding',
};
const SIDE_ADDONS: Record<Side, string> = { top: 'T', right: 'R', bottom: 'B', left: 'L' };

export function LayoutEditor({ style, draft, current, controller }: EditorProps) {
  const padding = draft.layout?.padding ?? {};
  const gap = draft.layout?.gap ?? {};
  const hasGap =
    current?.flow !== null || style.tokens.some((token) => token.property.endsWith('gap'));
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        {SIDES.map((side) => (
          <NumberField
            key={side}
            label={SIDE_LABELS[side]}
            value={padding[side] ?? current?.padding[side] ?? 0}
            range={SPACING_RANGE}
            addon={SIDE_ADDONS[side]}
            className="w-full"
            onChange={(value) => controller.editSpacing(side, value)}
          />
        ))}
      </div>
      {hasGap ? (
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Gap between rows"
            value={gap.row ?? current?.gap.row ?? 0}
            range={SPACING_RANGE}
            addon="↕"
            className="w-full"
            onChange={(value) => controller.editSpacing('row', value)}
          />
          <NumberField
            label="Gap between columns"
            value={gap.column ?? current?.gap.column ?? 0}
            range={SPACING_RANGE}
            addon="↔"
            className="w-full"
            onChange={(value) => controller.editSpacing('column', value)}
          />
        </div>
      ) : null}
    </div>
  );
}
