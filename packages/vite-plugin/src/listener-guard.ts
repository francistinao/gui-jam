type Add = EventTarget['addEventListener'];
type Remove = EventTarget['removeEventListener'];
type Listener = NonNullable<Parameters<Add>[1]>;
type Options = Parameters<Add>[2];
type RemoveOptions = Parameters<Remove>[2];
type Callback = (event: Event) => void;

export interface GuardRules {
  wraps(target: EventTarget): boolean;
  skips(event: Event, target: EventTarget): boolean;
}

export function capturing(options: Options | RemoveOptions): boolean {
  return typeof options === 'object' && options !== null
    ? Boolean(options.capture)
    : Boolean(options);
}

export function ownCode(stack: string | undefined, urls: readonly string[]): boolean {
  return stack !== undefined && urls.some((url) => stack.includes(url));
}

export function guardListeners(
  proto: EventTarget,
  rules: GuardRules,
): { add: Add; remove: Remove } {
  const add = proto.addEventListener;
  const remove = proto.removeEventListener;
  const guards = new WeakMap<EventTarget, Map<string, Map<Listener, Callback>>>();
  const key = (type: string, capture: boolean) => `${capture ? 'capture' : 'bubble'} ${type}`;

  function slot(target: EventTarget, type: string, capture: boolean): Map<Listener, Callback> {
    let byType = guards.get(target);
    if (!byType) {
      byType = new Map();
      guards.set(target, byType);
    }
    let byListener = byType.get(key(type, capture));
    if (!byListener) {
      byListener = new Map();
      byType.set(key(type, capture), byListener);
    }
    return byListener;
  }

  proto.addEventListener = function (
    this: EventTarget,
    type: string,
    listener: Listener | null,
    options?: Options,
  ): void {
    const signal = typeof options === 'object' ? options.signal : undefined;
    if (!listener) return;
    if (signal?.aborted || !rules.wraps(this)) {
      add.call(this, type, listener, options);
      return;
    }
    const capture = capturing(options);
    const byListener = slot(this, type, capture);
    let guard = byListener.get(listener);
    if (!guard) {
      const target = this;
      const once = typeof options === 'object' && options.once === true;
      const wrapped: Callback = function (this: EventTarget, event: Event) {
        if (rules.skips(event, target)) return;
        if (once) {
          remove.call(target, type, wrapped, { capture });
          byListener.delete(listener);
        }
        if (typeof listener === 'function') listener.call(this, event);
        else listener.handleEvent(event);
      };
      guard = wrapped;
      byListener.set(listener, wrapped);
      signal?.addEventListener('abort', () => byListener.delete(listener), { once: true });
    }
    add.call(
      this,
      type,
      guard,
      typeof options === 'object' ? { ...options, once: false } : options,
    );
  };

  proto.removeEventListener = function (
    this: EventTarget,
    type: string,
    listener: Listener | null,
    options?: RemoveOptions,
  ): void {
    if (!listener) return;
    const byListener = guards.get(this)?.get(key(type, capturing(options)));
    const guard = byListener?.get(listener);
    if (byListener && guard) {
      byListener.delete(listener);
      remove.call(this, type, guard, options);
    }
    remove.call(this, type, listener, options);
  };

  return { add, remove };
}
