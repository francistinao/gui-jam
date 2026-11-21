import { invoke } from '@forge/bridge';

export async function call<T>(key: string, payload?: Record<string, unknown>): Promise<T> {
  const answer = await invoke<T>(key, payload);
  if (typeof answer === 'object' && answer !== null && 'body' in answer && 'metadata' in answer) {
    return answer.body as T;
  }
  return answer as T;
}
