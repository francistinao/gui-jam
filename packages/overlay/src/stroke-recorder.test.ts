import { describe, expect, it } from 'vitest';
import type { Point } from './model';
import { IDLE_RECORDING, type PointerInput, type Recording, record } from './stroke-recorder';

const MOUSE = 1;
const PEN = 7;
const FINGER = 9;

const at = (x: number, y: number): Point => ({ x, y });

interface Press {
  pointerId?: number;
  isPrimary?: boolean;
  button?: number;
}

function down(point: Point, press: Press = {}): PointerInput {
  return {
    kind: 'down',
    pointerId: press.pointerId ?? MOUSE,
    isPrimary: press.isPrimary ?? true,
    button: press.button ?? 0,
    point,
  };
}

function move(points: Point[], pointerId = MOUSE, pressed = true): PointerInput {
  return { kind: 'move', pointerId, pressed, points };
}

function up(point: Point, pointerId = MOUSE): PointerInput {
  return { kind: 'up', pointerId, point };
}

function cancel(pointerId = MOUSE): PointerInput {
  return { kind: 'cancel', pointerId };
}

function play(inputs: readonly PointerInput[]): { recording: Recording; strokes: Point[][] } {
  let recording = IDLE_RECORDING;
  const strokes: Point[][] = [];
  for (const input of inputs) {
    const step = record(recording, input);
    recording = step.recording;
    strokes.push(...step.strokes);
  }
  return { recording, strokes };
}

describe('record', () => {
  it('turns a press, moves and a release into one stroke that ends where the button came up', () => {
    const { recording, strokes } = play([
      down(at(10, 10)),
      move([at(20, 12)]),
      move([at(30, 14)]),
      up(at(34, 15)),
    ]);

    expect(strokes).toEqual([[at(10, 10), at(20, 12), at(30, 14), at(34, 15)]]);
    expect(recording).toEqual(IDLE_RECORDING);
  });

  it('keeps every coalesced sample and skips repeats of the last point', () => {
    const { strokes } = play([
      down(at(0, 0)),
      move([at(1, 1), at(2, 2), at(2, 2), at(3, 3)]),
      up(at(3, 3)),
    ]);

    expect(strokes).toEqual([[at(0, 0), at(1, 1), at(2, 2), at(3, 3)]]);
  });

  it('drops a click that never moved, so there is nothing invisible to undo', () => {
    expect(play([down(at(5, 5)), up(at(5, 5))]).strokes).toEqual([]);
    expect(play([down(at(5, 5)), move([at(5, 5)]), up(at(5, 5))]).strokes).toEqual([]);
  });

  it('ignores presses of other buttons and of pointers that are not primary', () => {
    const right = down(at(0, 0), { button: 2 });
    const palm = down(at(40, 40), { pointerId: FINGER, isPrimary: false });

    expect(play([right, move([at(9, 9)]), up(at(9, 9))]).strokes).toEqual([]);
    expect(
      play([down(at(0, 0)), palm, move([at(50, 50)], FINGER), move([at(6, 6)]), up(at(8, 8))])
        .strokes,
    ).toEqual([[at(0, 0), at(6, 6), at(8, 8)]]);
  });

  it('ignores moves and releases of a pointer that is not drawing', () => {
    const { recording, strokes } = play([
      move([at(1, 1)]),
      up(at(1, 1)),
      down(at(0, 0)),
      move([at(3, 3)], PEN),
      up(at(4, 4), PEN),
    ]);

    expect(strokes).toEqual([]);
    expect(recording).toEqual({ pointerId: MOUSE, points: [at(0, 0)] });
  });

  it('keeps a stroke whose release was missed when the next one starts', () => {
    const { strokes } = play([
      down(at(0, 0)),
      move([at(10, 0)]),
      down(at(0, 20)),
      move([at(10, 20)]),
      up(at(12, 20)),
    ]);

    expect(strokes).toEqual([
      [at(0, 0), at(10, 0)],
      [at(0, 20), at(10, 20), at(12, 20)],
    ]);
  });

  it('finishes the open stroke when another primary pointer starts drawing', () => {
    const { strokes } = play([
      down(at(0, 0)),
      move([at(5, 5)]),
      down(at(50, 50), { pointerId: PEN }),
      up(at(60, 60), PEN),
    ]);

    expect(strokes).toEqual([
      [at(0, 0), at(5, 5)],
      [at(50, 50), at(60, 60)],
    ]);
  });

  it('finishes the stroke at the last point when a move arrives with the button already up', () => {
    const { recording, strokes } = play([
      down(at(0, 0)),
      move([at(8, 8)]),
      move([at(90, 90)], MOUSE, false),
      move([at(95, 95)], MOUSE, false),
    ]);

    expect(strokes).toEqual([[at(0, 0), at(8, 8)]]);
    expect(recording).toEqual(IDLE_RECORDING);
  });

  it('keeps what was drawn before a cancel, and drops a cancelled press', () => {
    expect(play([down(at(0, 0)), move([at(4, 4)]), cancel(), up(at(9, 9))]).strokes).toEqual([
      [at(0, 0), at(4, 4)],
    ]);
    expect(play([down(at(0, 0)), cancel()]).strokes).toEqual([]);
    expect(play([down(at(0, 0)), move([at(4, 4)]), cancel(PEN)]).recording.points).toHaveLength(2);
  });

  it('returns the same recording when nothing changed', () => {
    const drawing = record(IDLE_RECORDING, down(at(1, 1))).recording;

    expect(record(IDLE_RECORDING, move([at(2, 2)])).recording).toBe(IDLE_RECORDING);
    expect(record(drawing, move([at(2, 2)], PEN)).recording).toBe(drawing);
  });

  it('keeps all of a thousand strokes drawn back to back', () => {
    const inputs: PointerInput[] = [];
    for (let index = 0; index < 1000; index += 1) {
      const y = index * 3;
      inputs.push(down(at(0, y)), move([at(5, y + 1)]), up(at(9, y + 2)));
    }

    const { strokes } = play(inputs);

    expect(strokes).toHaveLength(1000);
    expect(strokes.at(-1)).toEqual([at(0, 2997), at(5, 2998), at(9, 2999)]);
  });
});
