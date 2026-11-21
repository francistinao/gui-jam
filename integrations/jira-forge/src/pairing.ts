import { createHash, randomBytes } from 'node:crypto';
import type { Store } from './store';

export interface AllowedProject {
  id: string;
  key: string;
  name: string;
  post: boolean;
  create: boolean;
}

export interface Pairing {
  accountId: string;
  label: string;
  createdAt: number;
  lastUsedAt: number;
  checkedAt: number;
  projects: AllowedProject[];
}

export interface Device {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number;
}

const MAX_DEVICES = 10;
const USE_EVERY_MS = 60 * 60 * 1000;

export const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex');
const pairingKey = (hash: string) => `pairing:${hash}`;
const devicesKey = (accountId: string) => `devices:${accountId}`;
const deviceId = (hash: string) => hash.slice(0, 12);

export function pairingCode(url: string, token: string): string {
  return `gjp_${Buffer.from(JSON.stringify({ v: 1, url, token })).toString('base64url')}`;
}

export async function createPairing(
  store: Store,
  accountId: string,
  label: string,
  projects: AllowedProject[],
  url: string,
  now: number,
  token = randomBytes(32).toString('base64url'),
): Promise<{ code: string; device: Device }> {
  const hash = hashOf(token);
  const record: Pairing = {
    accountId,
    label: label.slice(0, 60) || 'GUIJam',
    createdAt: now,
    lastUsedAt: now,
    checkedAt: now,
    projects,
  };
  await store.set(pairingKey(hash), record);
  const hashes = (await store.get<string[]>(devicesKey(accountId))) ?? [];
  const kept = [...hashes.filter((entry) => entry !== hash), hash];
  for (const dropped of kept.slice(0, Math.max(0, kept.length - MAX_DEVICES))) {
    await store.delete(pairingKey(dropped));
  }
  await store.set(devicesKey(accountId), kept.slice(-MAX_DEVICES));
  return {
    code: pairingCode(url, token),
    device: { id: deviceId(hash), label: record.label, createdAt: now, lastUsedAt: now },
  };
}

export async function findPairing(
  store: Store,
  token: string,
): Promise<{ hash: string; pairing: Pairing } | undefined> {
  if (token.length < 32 || token.length > 128) return undefined;
  const hash = hashOf(token);
  const pairing = await store.get<Pairing>(pairingKey(hash));
  return pairing ? { hash, pairing } : undefined;
}

export async function touch(store: Store, hash: string, pairing: Pairing, now: number) {
  if (now - pairing.lastUsedAt < USE_EVERY_MS) return;
  await store.set(pairingKey(hash), { ...pairing, lastUsedAt: now });
}

export async function devices(store: Store, accountId: string): Promise<Device[]> {
  const hashes = (await store.get<string[]>(devicesKey(accountId))) ?? [];
  const found: Device[] = [];
  for (const hash of hashes) {
    const pairing = await store.get<Pairing>(pairingKey(hash));
    if (pairing) {
      found.push({
        id: deviceId(hash),
        label: pairing.label,
        createdAt: pairing.createdAt,
        lastUsedAt: pairing.lastUsedAt,
      });
    }
  }
  return found;
}

export async function revoke(store: Store, accountId: string, id: string): Promise<boolean> {
  const hashes = (await store.get<string[]>(devicesKey(accountId))) ?? [];
  const hash = hashes.find((entry) => deviceId(entry) === id);
  if (!hash) return false;
  await store.delete(pairingKey(hash));
  await store.set(
    devicesKey(accountId),
    hashes.filter((entry) => entry !== hash),
  );
  return true;
}

export async function revokeHash(store: Store, hash: string, pairing: Pairing): Promise<void> {
  await revoke(store, pairing.accountId, deviceId(hash));
}

export async function refreshProjects(
  store: Store,
  accountId: string,
  projects: AllowedProject[],
  now: number,
): Promise<void> {
  const hashes = (await store.get<string[]>(devicesKey(accountId))) ?? [];
  for (const hash of hashes) {
    const pairing = await store.get<Pairing>(pairingKey(hash));
    if (pairing) await store.set(pairingKey(hash), { ...pairing, projects, checkedAt: now });
  }
}

export async function lastChecked(store: Store, accountId: string): Promise<number | undefined> {
  const hashes = (await store.get<string[]>(devicesKey(accountId))) ?? [];
  const first = hashes[0];
  if (!first) return undefined;
  return (await store.get<Pairing>(pairingKey(first)))?.checkedAt;
}
