import { kvs } from '@forge/kvs';

export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export const forgeStore: Store = {
  get: (key) => kvs.get(key),
  set: (key, value, ttlSeconds) =>
    ttlSeconds === undefined
      ? kvs.set(key, value)
      : kvs.set(key, value, { ttl: { value: ttlSeconds, unit: 'SECONDS' } }),
  delete: (key) => kvs.delete(key),
};

export function memoryStore(): Store & { keys(): string[] } {
  const values = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    set: async (key, value) => {
      values.set(key, structuredClone(value));
    },
    delete: async (key) => {
      values.delete(key);
    },
    keys: () => [...values.keys()],
  };
}
