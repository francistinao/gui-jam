import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileMap } from './file-map.js';
import { fsUrl, insideProject } from './next-paths.js';

describe('insideProject', () => {
  it('gives a slash-separated path for files in the project', () => {
    expect(insideProject('/repo/app', '/repo/app/src/A.tsx', path.posix)).toBe('src/A.tsx');
    expect(insideProject('C:/Repo/app', 'c:/repo/app/src/A.tsx', path.win32)).toBe('src/A.tsx');
    expect(insideProject('C:\\repo\\app', 'C:\\repo\\app\\src\\A.tsx', path.win32)).toBe(
      'src/A.tsx',
    );
  });

  it('treats parent folders, other drives and the root itself as outside', () => {
    expect(insideProject('/repo/app', '/repo/other/A.tsx', path.posix)).toBeUndefined();
    expect(insideProject('/repo/app', '/repo/app', path.posix)).toBeUndefined();
    expect(insideProject('C:/repo/app', 'D:/repo/app/src/A.tsx', path.win32)).toBeUndefined();
    expect(insideProject('/repo/app', '/repo/app/..hidden/A.tsx', path.posix)).toBe(
      '..hidden/A.tsx',
    );
  });
});

describe('fsUrl', () => {
  it('serves files outside the root through /@fs/ on every platform', () => {
    expect(fsUrl('/Users/me/shared/logo.svg')).toBe('/@fs/Users/me/shared/logo.svg');
    expect(fsUrl('C:/Users/me/shared/logo.svg')).toBe('/@fs/C:/Users/me/shared/logo.svg');
    expect(fsUrl('C:\\Users\\me\\logo.svg')).toBe('/@fs/C:/Users/me/logo.svg');
  });
});

describe('FileMap', () => {
  it('matches Windows paths whatever their case or slashes', () => {
    const files = new FileMap<string>('win32');
    files.set('C:/Users/Me/app/src/A.tsx', 'a');
    expect(files.get('c:/users/me/app/src/a.tsx')).toBe('a');
    expect(files.has('C:\\Users\\Me\\app\\src\\A.tsx')).toBe(true);
    expect(files.delete('c:/USERS/me/app/src/A.tsx')).toBe(true);
    expect(files.has('C:/Users/Me/app/src/A.tsx')).toBe(false);
  });

  it('keeps paths exact elsewhere', () => {
    const files = new FileMap<string>('darwin');
    files.set('/repo/app/A.tsx', 'a');
    expect(files.get('/repo/app/a.tsx')).toBeUndefined();
    expect(files.get('/repo/app/A.tsx')).toBe('a');
  });
});
