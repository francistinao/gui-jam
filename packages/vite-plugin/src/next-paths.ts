import path, { join, sep } from 'node:path';

export const TAILWIND_ROOT = /@import\s+["']tailwindcss["']|@tailwind\s+utilities/;

export function toPosix(path: string): string {
  return path.split(sep).join('/');
}

export function insideProject(
  root: string,
  file: string,
  paths: path.PlatformPath = path,
): string | undefined {
  const inside = paths.relative(root, file);
  if (inside === '' || paths.isAbsolute(inside) || /^\.\.(?:[\\/]|$)/.test(inside)) {
    return undefined;
  }
  return inside.split(paths.sep).join('/');
}

export function fsUrl(file: string): string {
  return `/@fs/${file.replaceAll('\\', '/').replace(/^\/+/, '')}`;
}

export function runDir(root: string): string {
  return join(root, '.guijam', 'run');
}

export function overlayFileOf(root: string, projectPath: string): string {
  return join(runDir(root), 'overlays', encodeURIComponent(projectPath));
}

export function candidatesDirOf(root: string): string {
  return join(runDir(root), 'candidates');
}
