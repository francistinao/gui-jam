export const MIN_NEXT: readonly [number, number] = [16, 3];

export function supportsNext(version: string | undefined): boolean {
  const [major = Number.NaN, minor = Number.NaN] = (version ?? '').split('.').map(Number);
  return major > MIN_NEXT[0] || (major === MIN_NEXT[0] && minor >= MIN_NEXT[1]);
}
