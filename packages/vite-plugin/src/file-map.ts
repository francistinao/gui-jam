export class FileMap<V> {
  readonly #entries = new Map<string, V>();
  readonly #key: (file: string) => string;

  constructor(platform: NodeJS.Platform = process.platform) {
    this.#key =
      platform === 'win32' ? (file) => file.replaceAll('\\', '/').toLowerCase() : (file) => file;
  }

  get(file: string): V | undefined {
    return this.#entries.get(this.#key(file));
  }

  has(file: string): boolean {
    return this.#entries.has(this.#key(file));
  }

  set(file: string, value: V): this {
    this.#entries.set(this.#key(file), value);
    return this;
  }

  delete(file: string): boolean {
    return this.#entries.delete(this.#key(file));
  }
}
