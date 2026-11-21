import { randomBytes } from 'node:crypto';

export interface Multipart {
  body: ArrayBuffer;
  contentType: string;
}

const SAFE_NAME = /[^A-Za-z0-9._-]/g;

export function multipartFile(
  field: string,
  filename: string,
  mimeType: string,
  bytes: Uint8Array,
  boundary = `guijam${randomBytes(12).toString('hex')}`,
): Multipart {
  const name = filename.replace(SAFE_NAME, '_') || 'file';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const joined = Buffer.concat([head, Buffer.from(bytes), tail]);
  const body = joined.buffer.slice(joined.byteOffset, joined.byteOffset + joined.byteLength);
  return { body: body as ArrayBuffer, contentType: `multipart/form-data; boundary=${boundary}` };
}
