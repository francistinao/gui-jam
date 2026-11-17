import { join, relative, sep } from 'node:path';

export const TAILWIND_ROOT = /@import\s+["']tailwindcss["']|@tailwind\s+utilities/;

export function toPosix(path: string): string {
  return path.split(sep).join('/');
}

export function projectPathOf(root: string, file: string): string {
  return toPosix(relative(root, file));
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
