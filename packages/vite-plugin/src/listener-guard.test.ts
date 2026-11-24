import { describe, expect, it, vi } from 'vitest';
import { capturing, guardListeners, ownCode } from './listener-guard.js';

class Target extends EventTarget {}
const exempt = new Target();
guardListeners(Target.prototype, {
  wraps: (target) => target !== exempt,
  skips: (event) => (event as Event & { guijam?: boolean }).guijam === true,
});

function guijamEvent(type = 'ping'): Event {
  return Object.assign(new Event(type), { guijam: true });
}

describe('guardListeners', () => {
  it('hides GUIJam events from page listeners and passes the page its own', () => {
    const target = new Target();
    const listener = vi.fn();
    target.addEventListener('ping', listener);

    target.dispatchEvent(guijamEvent());
    target.dispatchEvent(new Event('ping'));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toBeInstanceOf(Event);
  });

  it('leaves listeners on exempt targets alone', () => {
    const listener = vi.fn();
    exempt.addEventListener('ping', listener);

    exempt.dispatchEvent(guijamEvent());

    expect(listener).toHaveBeenCalledTimes(1);
    exempt.removeEventListener('ping', listener);
  });

  it('removes a wrapped listener and ignores a duplicate add', () => {
    const target = new Target();
    const listener = vi.fn();
    target.addEventListener('ping', listener);
    target.addEventListener('ping', listener);

    target.dispatchEvent(new Event('ping'));
    target.removeEventListener('ping', listener);
    target.dispatchEvent(new Event('ping'));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keys capture and bubble registrations apart', () => {
    const target = new Target();
    const listener = vi.fn();
    target.addEventListener('ping', listener, { capture: true });

    target.removeEventListener('ping', listener);
    target.dispatchEvent(new Event('ping'));
    target.removeEventListener('ping', listener, { capture: true });
    target.dispatchEvent(new Event('ping'));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps a once listener for the first page event after GUIJam ones', () => {
    const target = new Target();
    const listener = vi.fn();
    target.addEventListener('ping', listener, { once: true });

    target.dispatchEvent(guijamEvent());
    target.dispatchEvent(new Event('ping'));
    target.dispatchEvent(new Event('ping'));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('drops a listener when its signal aborts', () => {
    const target = new Target();
    const listener = vi.fn();
    const controller = new AbortController();
    target.addEventListener('ping', listener, { signal: controller.signal });

    controller.abort();
    target.dispatchEvent(new Event('ping'));

    expect(listener).not.toHaveBeenCalled();
  });

  it('calls handleEvent on listener objects with the object as this', () => {
    const target = new Target();
    const seen: unknown[] = [];
    const listener = {
      handleEvent(this: unknown) {
        seen.push(this);
      },
    };
    target.addEventListener('ping', listener);

    target.dispatchEvent(new Event('ping'));

    expect(seen).toEqual([listener]);
  });

  it('calls function listeners with the current target as this', () => {
    const target = new Target();
    let self: unknown;
    target.addEventListener('ping', function (this: unknown) {
      self = this;
    });

    target.dispatchEvent(new Event('ping'));

    expect(self).toBe(target);
  });
});

describe('capturing', () => {
  it('reads the capture flag the way addEventListener does', () => {
    expect(capturing(true)).toBe(true);
    expect(capturing({ capture: true, passive: true })).toBe(true);
    expect(capturing({ passive: true })).toBe(false);
    expect(capturing(undefined)).toBe(false);
  });
});

describe('ownCode', () => {
  const widget = 'http://localhost:5173/@guijam/widget.js';

  it('finds the widget in Chrome, Firefox and Safari stacks', () => {
    const chrome = `Error\n    at addEventListener (http://localhost:5173/@id/virtual:guijam/client:12:3)\n    at useDismiss (${widget}:4410:22)`;
    const firefox = `addEventListener@http://localhost:5173/@id/virtual:guijam/client:12:3\nuseDismiss@${widget}:4410:22`;
    const safari = `addEventListener@http://localhost:5173/@id/virtual:guijam/client:12:3\nuseDismiss@${widget}:4410:22\nglobal code`;

    for (const stack of [chrome, firefox, safari]) expect(ownCode(stack, [widget])).toBe(true);
  });

  it('treats page code and a missing stack as the page', () => {
    const page =
      'Error\n    at DismissableLayer (http://localhost:5173/node_modules/.vite/deps/radix-ui.js:88:5)';

    expect(ownCode(page, [widget])).toBe(false);
    expect(ownCode(undefined, [widget])).toBe(false);
    expect(ownCode(page, [])).toBe(false);
  });
});
