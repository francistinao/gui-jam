import type { DomPatch } from '@guijam/contracts-ts';
import { describe, expect, it } from 'vitest';
import { DomPreview, type PatchableElement } from './dom-preview';

class FakeElement implements PatchableElement {
  readonly attributes = new Map<string, string>();

  constructor(className: string | null, style: string | null) {
    if (className !== null) this.attributes.set('class', className);
    if (style !== null) this.attributes.set('style', style);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  get classList() {
    const tokens = () => (this.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    const write = (next: string[]) => this.setAttribute('class', next.join(' '));
    return {
      add: (...added: string[]) =>
        write([...tokens(), ...added.filter((t) => !tokens().includes(t))]),
      remove: (...removed: string[]) => write(tokens().filter((t) => !removed.includes(t))),
    };
  }

  get style() {
    const declarations = () =>
      new Map(
        (this.getAttribute('style') ?? '')
          .split(';')
          .map((part) => part.split(':').map((side) => side.trim()))
          .filter(([property, value]) => property && value)
          .map(([property, value]) => [property ?? '', value ?? '']),
      );
    const write = (next: Map<string, string>) =>
      this.setAttribute(
        'style',
        [...next].map(([property, value]) => `${property}: ${value}`).join('; '),
      );
    return {
      setProperty: (property: string, value: string, priority = '') => {
        const next = declarations();
        next.set(property, priority ? `${value} !${priority}` : value);
        write(next);
      },
      removeProperty: (property: string) => {
        const next = declarations();
        const old = next.get(property) ?? '';
        next.delete(property);
        write(next);
        return old;
      },
    };
  }
}

const patch = (overrides: Partial<DomPatch>): DomPatch => ({
  src: 'src/pages/index.astro:21:7',
  addClasses: [],
  removeClasses: [],
  setStyles: [],
  removeStyles: [],
  ...overrides,
});

describe('DomPreview', () => {
  it('applies class and style changes to every copy of the element and reverts exactly', () => {
    const first = new FakeElement('mt-6 bg-brand', 'padding: 16px; color: red');
    const second = new FakeElement('mt-6 bg-brand data-astro-cid-x', null);
    const preview = new DomPreview<FakeElement>();

    preview.apply(
      patch({
        addClasses: ['bg-[#1D4ED8]'],
        removeClasses: ['bg-brand'],
        setStyles: [{ property: 'background-color', value: '#1D4ED8' }],
        removeStyles: ['color'],
      }),
      [first, second],
    );

    expect(first.getAttribute('class')).toBe('mt-6 bg-[#1D4ED8]');
    expect(first.getAttribute('style')).toBe('padding: 16px; background-color: #1D4ED8');
    expect(second.getAttribute('class')).toBe('mt-6 data-astro-cid-x bg-[#1D4ED8]');

    preview.revert();

    expect(first.getAttribute('class')).toBe('mt-6 bg-brand');
    expect(first.getAttribute('style')).toBe('padding: 16px; color: red');
    expect(second.getAttribute('style')).toBeNull();
  });

  it('starts each new patch from the original attributes, not the previous patch', () => {
    const element = new FakeElement('rounded-lg bg-brand', null);
    const preview = new DomPreview<FakeElement>();

    preview.apply(patch({ addClasses: ['bg-red-500'], removeClasses: ['bg-brand'] }), [element]);
    preview.apply(patch({ addClasses: ['bg-blue-500'], removeClasses: ['bg-brand'] }), [element]);

    expect(element.getAttribute('class')).toBe('rounded-lg bg-blue-500');
  });

  it('undoes optimistic changes made after remember, and keeps a committed preview', () => {
    const element = new FakeElement('mt-6', 'background-color: #fde68a');
    const preview = new DomPreview<FakeElement>();

    preview.remember(element);
    element.style.removeProperty('background-color');
    preview.apply(
      patch({ setStyles: [{ property: 'border-radius', value: '9999px !important' }] }),
      [element],
    );

    expect(element.getAttribute('style')).toBe(
      'background-color: #fde68a; border-radius: 9999px !important',
    );
    preview.keep();
    preview.revert();
    expect(element.getAttribute('style')).toBe(
      'background-color: #fde68a; border-radius: 9999px !important',
    );
  });
});
