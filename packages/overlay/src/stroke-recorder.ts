import type { Point } from './model';

export type PointerInput =
  | {
      kind: 'down';
      pointerId: number;
      isPrimary: boolean;
      button: number;
      point: Point;
    }
  | { kind: 'move'; pointerId: number; pressed: boolean; points: readonly Point[] }
  | { kind: 'up'; pointerId: number; point: Point }
  | { kind: 'cancel'; pointerId: number };

export interface Recording {
  readonly pointerId: number | null;
  readonly points: readonly Point[];
}

export interface Recorded {
  recording: Recording;
  strokes: Point[][];
}

export const IDLE_RECORDING: Recording = { pointerId: null, points: [] };

function drawn(points: readonly Point[]): boolean {
  const [first] = points;
  return first !== undefined && points.some((point) => point.x !== first.x || point.y !== first.y);
}

function finish(points: readonly Point[]): Point[][] {
  return drawn(points) ? [[...points]] : [];
}

function appended(points: readonly Point[], more: readonly Point[]): Point[] {
  const next = [...points];
  for (const point of more) {
    const last = next.at(-1);
    if (!last || last.x !== point.x || last.y !== point.y) next.push(point);
  }
  return next;
}

export function record(recording: Recording, input: PointerInput): Recorded {
  const unchanged = { recording, strokes: [] };
  if (input.kind === 'down') {
    if (input.button !== 0 || !input.isPrimary) return unchanged;
    return {
      recording: { pointerId: input.pointerId, points: [input.point] },
      strokes: recording.pointerId === null ? [] : finish(recording.points),
    };
  }
  if (recording.pointerId === null || input.pointerId !== recording.pointerId) return unchanged;
  switch (input.kind) {
    case 'move':
      if (!input.pressed) return { recording: IDLE_RECORDING, strokes: finish(recording.points) };
      return {
        recording: { ...recording, points: appended(recording.points, input.points) },
        strokes: [],
      };
    case 'up':
      return {
        recording: IDLE_RECORDING,
        strokes: finish(appended(recording.points, [input.point])),
      };
    case 'cancel':
      return { recording: IDLE_RECORDING, strokes: finish(recording.points) };
    default: {
      const never: never = input;
      return never;
    }
  }
}
