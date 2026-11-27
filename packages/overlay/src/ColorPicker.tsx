import { Popover } from '@base-ui/react/popover';
import { Slider } from '@base-ui/react/slider';
import type { ThemeColor } from '@guijam/contracts-ts';
import { Pipette } from 'lucide-react';
import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  COLOR_MODES,
  type ColorMode,
  channels,
  type Hsv,
  hexToHsv,
  hsvToHex,
  withChannel,
} from './color';
import { ColorChit } from './figui/color-chit';
import { NumericInput, NumericInputRoot } from './figui/numeric-input';
import { TextInput } from './figui/text-input';
import { clamp, OPACITY_RANGE, parseHex } from './model';

type ChannelMode = Exclude<ColorMode, 'hex'>;

const CHANNEL_LABELS: Record<ChannelMode, readonly [string, string, string]> = {
  rgb: ['Red', 'Green', 'Blue'],
  hsl: ['Hue', 'Saturation', 'Lightness'],
  hsb: ['Hue', 'Saturation', 'Brightness'],
};
const CHANNEL_INDEXES = [0, 1, 2] as const;
const CHECKERBOARD = 'conic-gradient(#eee 25%, #ccc 0 50%, #eee 0 75%, #ccc 0)';
const HUES = 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)';
const STEP = 1;
const BIG_STEP = 10;

interface EyeDropperApi {
  open(): Promise<{ sRGBHex: string }>;
}

type EyeDropperConstructor = new () => EyeDropperApi;

function eyeDropper(): EyeDropperConstructor | undefined {
  return (window as Window & { EyeDropper?: EyeDropperConstructor }).EyeDropper;
}

const fraction = (value: number) => Math.min(1, Math.max(0, value));

function SaturationArea({ hsv, onChange }: { hsv: Hsv; onChange(next: Hsv): void }) {
  const area = useRef<HTMLDivElement>(null);
  const pick = (event: PointerEvent<HTMLDivElement>) => {
    const box = area.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return;
    onChange({
      ...hsv,
      s: fraction((event.clientX - box.left) / box.width) * 100,
      v: (1 - fraction((event.clientY - box.top) / box.height)) * 100,
    });
  };
  const nudge = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? BIG_STEP : STEP;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    onChange({
      ...hsv,
      s: fraction((hsv.s + move[0]) / 100) * 100,
      v: fraction((hsv.v + move[1]) / 100) * 100,
    });
  };
  return (
    <div
      ref={area}
      data-saturation-area=""
      className="relative h-36 w-full cursor-crosshair touch-none rounded-md"
      style={{
        backgroundColor: `hsl(${hsv.h} 100% 50%)`,
        backgroundImage:
          'linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)',
      }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        pick(event);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) pick(event);
      }}
    >
      <div
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.s)}
        aria-valuetext={`Saturation ${Math.round(hsv.s)}%, brightness ${Math.round(hsv.v)}%`}
        className="absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white-1000 shadow-200 ring-1 ring-black-200 focus-visible:outline-2 focus-visible:outline-blue-500"
        style={{ left: `${hsv.s}%`, top: `${100 - hsv.v}%`, backgroundColor: hsvToHex(hsv) }}
        onKeyDown={nudge}
      />
    </div>
  );
}

function ColorSlider({
  label,
  value,
  max,
  background,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  background: string;
  onChange(next: number): void;
}) {
  return (
    <Slider.Root
      value={value}
      min={0}
      max={max}
      thumbAlignment="edge"
      onValueChange={(next) => onChange(next)}
    >
      <Slider.Control className="flex h-4 w-full items-center">
        <Slider.Track
          className="relative h-3 w-full rounded-full ring-1 ring-black-100 ring-inset"
          style={{ backgroundImage: background, backgroundSize: '100% 100%, 8px 8px' }}
        >
          <Slider.Thumb
            aria-label={label}
            className="size-3.5 rounded-full border-2 border-white-1000 shadow-200 ring-1 ring-black-200 focus-visible:outline-2 focus-visible:outline-blue-500"
          />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  );
}

function HexInput({ hex, onChange }: { hex: string; onChange(next: string): void }) {
  const [text, setText] = useState(hex.slice(1));
  useEffect(() => setText(hex.slice(1)), [hex]);
  return (
    <TextInput
      aria-label="Hex"
      value={text}
      className="w-20 flex-1 uppercase"
      onChange={(event) => {
        setText(event.target.value);
        const parsed = parseHex(event.target.value);
        if (parsed) onChange(parsed);
      }}
      onBlur={() => {
        if (!parseHex(text)) setText(hex.slice(1));
      }}
    />
  );
}

export function ColorPicker({
  label = 'Fill',
  hex,
  opacity,
  colors,
  token,
  onColor,
  onToken,
}: {
  label?: string;
  hex: string;
  opacity: number;
  colors: readonly ThemeColor[];
  token: string | undefined;
  onColor(hex: string, opacity: number): void;
  onToken(name: string): void;
}) {
  const [hsv, setHsv] = useState(() => hexToHsv(hex));
  const [mode, setMode] = useState<ColorMode>('hex');
  const [layer, setLayer] = useState<HTMLElement | null>(null);
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  const trigger = useCallback((node: HTMLButtonElement | null) => {
    setLayer(node?.closest<HTMLElement>('.guijam-layer') ?? null);
    setPanel(node?.closest<HTMLElement>('[role="dialog"]') ?? null);
  }, []);
  useEffect(() => {
    setHsv((current) => (hsvToHex(current) === hex ? current : hexToHsv(hex, current)));
  }, [hex]);
  const change = (next: Hsv) => {
    setHsv(next);
    onColor(hsvToHex(next), opacity);
  };
  const shown = hsvToHex(hsv);
  const Dropper = eyeDropper();
  return (
    <Popover.Root>
      <Popover.Trigger
        ref={trigger}
        aria-label={`${label} color`}
        className="grid cursor-pointer place-items-center rounded-sm border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-blue-500"
      >
        <ColorChit color={hex} opacity={opacity} />
      </Popover.Trigger>
      <Popover.Portal container={layer}>
        <Popover.Positioner
          anchor={panel}
          side="left"
          align="start"
          sideOffset={8}
          collisionPadding={12}
        >
          <Popover.Popup
            data-interactive=""
            data-color-picker=""
            aria-label={`${label} color picker`}
            className="flex w-60 flex-col gap-3 rounded-[13px] bg-white-1000 p-3 text-black-800 shadow-500 ring-1 ring-black-100 outline-none"
          >
            <SaturationArea hsv={hsv} onChange={change} />
            <div className="flex items-center gap-2">
              {Dropper ? (
                <button
                  type="button"
                  aria-label="Pick a color from the screen"
                  title="Pick a color from the screen"
                  className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-transparent p-0 text-grey-700 hover:bg-grey-100"
                  onClick={() => {
                    new Dropper()
                      .open()
                      .then(({ sRGBHex }) => {
                        const picked = parseHex(sRGBHex);
                        if (picked) onColor(picked, opacity);
                      })
                      .catch((error: unknown) => {
                        if (!(error instanceof DOMException && error.name === 'AbortError')) {
                          throw error;
                        }
                      });
                  }}
                >
                  <Pipette aria-hidden="true" className="size-4" />
                </button>
              ) : null}
              <div className="flex flex-1 flex-col gap-2">
                <ColorSlider
                  label="Hue"
                  value={Math.round(hsv.h)}
                  max={360}
                  background={HUES}
                  onChange={(h) => change({ ...hsv, h })}
                />
                <ColorSlider
                  label="Opacity"
                  value={opacity}
                  max={OPACITY_RANGE.max}
                  background={`linear-gradient(to right, transparent, ${shown}), ${CHECKERBOARD}`}
                  onChange={(next) => onColor(shown, clamp(Math.round(next), OPACITY_RANGE))}
                />
              </div>
            </div>
            <div className="flex items-center gap-1">
              <select
                aria-label="Color mode"
                value={mode}
                className="typography-body-small h-6 cursor-pointer rounded-md border-0 bg-grey-100 px-1"
                onChange={(event) => {
                  const picked = COLOR_MODES.find((item) => item.mode === event.target.value);
                  if (picked) setMode(picked.mode);
                }}
              >
                {COLOR_MODES.map((item) => (
                  <option key={item.mode} value={item.mode}>
                    {item.label}
                  </option>
                ))}
              </select>
              {mode === 'hex' ? (
                <HexInput hex={shown} onChange={(next) => onColor(next, opacity)} />
              ) : (
                CHANNEL_INDEXES.map((index) => (
                  <NumericInputRoot
                    key={`${mode}-${CHANNEL_LABELS[mode][index]}`}
                    className="min-w-0 flex-1"
                    value={channels(mode, hsv)[index]}
                    onValueChange={(next) => {
                      if (next !== null) change(withChannel(mode, hsv, index, next));
                    }}
                  >
                    <NumericInput
                      aria-label={CHANNEL_LABELS[mode][index]}
                      className="w-full text-center"
                    />
                  </NumericInputRoot>
                ))
              )}
              <NumericInputRoot
                className="w-12 shrink-0"
                value={opacity}
                min={OPACITY_RANGE.min}
                max={OPACITY_RANGE.max}
                onValueChange={(next) => {
                  if (next !== null) onColor(shown, clamp(Math.round(next), OPACITY_RANGE));
                }}
              >
                <NumericInput aria-label="Opacity percent" className="w-full text-center" />
              </NumericInputRoot>
            </div>
            {colors.length > 0 ? (
              <section aria-label="Theme colors" className="flex flex-col gap-1.5">
                <h4 className="typography-body-small m-0 font-[500] text-grey-600">Theme colors</h4>
                <div className="flex flex-wrap gap-1">
                  {colors.map((color) => (
                    <button
                      key={color.name}
                      type="button"
                      aria-label={`Theme color ${color.name}`}
                      aria-pressed={token === color.name}
                      title={color.name}
                      className="size-5 cursor-pointer rounded-sm border-0 p-0 inset-ring inset-ring-black-200 aria-pressed:ring-2 aria-pressed:ring-blue-500"
                      style={{ backgroundColor: color.value }}
                      onClick={() => onToken(color.name)}
                    />
                  ))}
                </div>
              </section>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
