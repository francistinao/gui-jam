import { describe, expect, it } from 'vitest';
import {
  checkSource,
  encodingFor,
  fittedSize,
  imageFiles,
  MAX_SOURCE_BYTES,
  overflowNote,
  roomFor,
} from './attachments';

describe('checkSource', () => {
  it('accepts the four image types up to 20 MB', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
      expect(checkSource('shot', type, 1024)).toEqual({ ok: true });
    }
    expect(checkSource('big.png', 'image/png', MAX_SOURCE_BYTES)).toEqual({ ok: true });
  });

  it('explains every refusal', () => {
    expect(checkSource('notes.txt', 'text/plain', 10)).toEqual({
      ok: false,
      reason: "notes.txt isn't an image GUIJam can use. Attach a PNG, JPEG, WebP or GIF.",
    });
    expect(checkSource('logo.svg', 'image/svg+xml', 10)).toMatchObject({ ok: false });
    expect(checkSource('photo.heic', 'image/heic', 10)).toMatchObject({ ok: false });
    expect(checkSource('blank.png', 'image/png', 0)).toEqual({
      ok: false,
      reason: 'blank.png is empty.',
    });
    expect(checkSource('huge.jpg', 'image/jpeg', MAX_SOURCE_BYTES + 1)).toEqual({
      ok: false,
      reason: 'huge.jpg is 20.0 MB; images can be up to 20 MB.',
    });
  });
});

describe('fittedSize', () => {
  it('scales the longest side down to 1568 and never up', () => {
    expect(fittedSize(3136, 2000)).toEqual({ width: 1568, height: 1000 });
    expect(fittedSize(1000, 4000)).toEqual({ width: 392, height: 1568 });
    expect(fittedSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fittedSize(1568, 1568)).toEqual({ width: 1568, height: 1568 });
    expect(fittedSize(20_000, 2)).toEqual({ width: 1568, height: 1 });
  });
});

describe('encoding and room', () => {
  it('keeps transparency as PNG and flattens the rest to JPEG', () => {
    expect(encodingFor(true)).toBe('image/png');
    expect(encodingFor(false)).toBe('image/jpeg');
  });

  it('fills up to four and says how many did not fit', () => {
    expect(roomFor(0, 2)).toBe(2);
    expect(roomFor(3, 2)).toBe(1);
    expect(roomFor(4, 1)).toBe(0);
    expect(roomFor(2, 0)).toBe(0);
    expect(overflowNote(0)).toBeNull();
    expect(overflowNote(1)).toBe(
      "Up to 4 images fit, so 1 wasn't added. Remove one to add another.",
    );
    expect(overflowNote(3)).toBe(
      "Up to 4 images fit, so 3 weren't added. Remove one to add another.",
    );
  });

  it('picks the images out of a mixed paste', () => {
    const file = (name: string, type: string) => new File(['x'], name, { type });
    const picked = imageFiles([
      file('a.png', 'image/png'),
      file('b.txt', 'text/plain'),
      file('c.gif', 'image/gif'),
    ]);
    expect(picked.map((entry) => entry.name)).toEqual(['a.png', 'c.gif']);
  });
});
