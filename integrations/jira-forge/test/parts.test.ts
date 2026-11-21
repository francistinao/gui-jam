import { describe, expect, it } from 'vitest';
import { diffText, doc, paragraph, plainText, text } from '../src/adf';
import { multipartFile } from '../src/multipart';
import { createPairing, devices, findPairing, hashOf, pairingCode, revoke } from '../src/pairing';
import { memoryStore } from '../src/store';
import { NOW } from './fakes';

describe('ADF', () => {
  it('reads descriptions as plain text with paragraphs, lists, mentions and breaks', () => {
    const description = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Make it ' },
            { type: 'text', text: 'blue', marks: [{ type: 'strong' }] },
            { type: 'hardBreak' },
            { type: 'mention', attrs: { id: 'x', text: '@Ana' } },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'pill' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'bold' }] }],
            },
          ],
        },
      ],
    };
    expect(plainText(description)).toBe('Make it blue\n@Ana\n- pill\n- bold');
    expect(plainText(null)).toBe('');
    expect(plainText(doc(paragraph(text('Hi'))))).toBe('Hi');
  });

  it('shows changes as a compact diff', () => {
    expect(diffText([{ file: 'src/A.tsx', line: 3, before: ['<b>'], after: ['<i>', '<u>'] }])).toBe(
      '@@ src/A.tsx:3\n- <b>\n+ <i>\n+ <u>',
    );
  });
});

describe('multipart', () => {
  it('encodes one file field with a safe name and its own boundary', () => {
    const form = multipartFile(
      'file',
      'before 1/../x.jpg',
      'image/jpeg',
      new Uint8Array([1, 2, 3]),
      'b0',
    );
    expect(form.contentType).toBe('multipart/form-data; boundary=b0');
    const body = Buffer.from(form.body);
    const head =
      '--b0\r\nContent-Disposition: form-data; name="file"; filename="before_1_.._x.jpg"\r\nContent-Type: image/jpeg\r\n\r\n';
    expect(body.subarray(0, head.length).toString()).toBe(head);
    expect([...body.subarray(head.length, head.length + 3)]).toEqual([1, 2, 3]);
    expect(body.subarray(head.length + 3).toString()).toBe('\r\n--b0--\r\n');
  });
});

describe('pairing', () => {
  it('stores only a hash of the token and decodes to the url and token', async () => {
    const store = memoryStore();
    const token = 'tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab';
    const { code, device } = await createPairing(
      store,
      'acct',
      'Laptop',
      [],
      'https://t.example/x',
      NOW,
      token,
    );
    expect(store.keys().some((key) => key.includes(token))).toBe(false);
    expect(store.keys()).toContain(`pairing:${hashOf(token)}`);
    expect(code).toBe(pairingCode('https://t.example/x', token));
    expect(JSON.parse(Buffer.from(code.slice(4), 'base64url').toString())).toEqual({
      v: 1,
      url: 'https://t.example/x',
      token,
    });
    expect((await findPairing(store, token))?.pairing.accountId).toBe('acct');
    expect(await devices(store, 'acct')).toEqual([device]);
    expect(await revoke(store, 'acct', device.id)).toBe(true);
    expect(await findPairing(store, token)).toBeUndefined();
    expect(await revoke(store, 'acct', device.id)).toBe(false);
  });

  it('keeps at most ten devices per person and generates distinct tokens', async () => {
    const store = memoryStore();
    const codes = new Set<string>();
    for (let index = 0; index < 12; index += 1) {
      const { code } = await createPairing(
        store,
        'acct',
        `Device ${index}`,
        [],
        'https://t/x',
        NOW + index,
      );
      codes.add(code);
    }
    expect(codes.size).toBe(12);
    const kept = await devices(store, 'acct');
    expect(kept.map((device) => device.label)).toEqual(
      Array.from({ length: 10 }, (_, index) => `Device ${index + 2}`),
    );
  });
});
