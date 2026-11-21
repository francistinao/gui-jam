import type { DomPatch } from '@guijam/contracts-ts';
import { type NodeLike, type TextLike, textRuns } from './text-runs';

export interface PatchableElement {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  readonly classList: { add(...tokens: string[]): void; remove(...tokens: string[]): void };
  readonly style: {
    setProperty(property: string, value: string, priority?: string): void;
    removeProperty(property: string): string;
  };
  readonly childNodes: ArrayLike<NodeLike>;
}

interface Saved {
  className: string | null;
  style: string | null;
}

const IMPORTANT = /\s*!important\s*$/i;

function put(element: PatchableElement, name: string, value: string | null): void {
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}

export class DomPreview<Element extends PatchableElement> {
  private readonly originals = new Map<Element, Saved>();
  private readonly texts = new Map<TextLike, string>();

  remember(element: Element): void {
    if (this.originals.has(element)) return;
    this.originals.set(element, {
      className: element.getAttribute('class'),
      style: element.getAttribute('style'),
    });
  }

  apply(
    patch: DomPatch,
    elements: readonly Element[],
    texted: readonly Element[] = elements,
  ): void {
    this.restore();
    for (const element of elements) {
      this.remember(element);
      if (patch.removeClasses.length > 0) element.classList.remove(...patch.removeClasses);
      if (patch.addClasses.length > 0) element.classList.add(...patch.addClasses);
      for (const property of patch.removeStyles) element.style.removeProperty(property);
      for (const { property, value } of patch.setStyles) {
        const priority = IMPORTANT.test(value) ? 'important' : '';
        element.style.setProperty(property, value.replace(IMPORTANT, ''), priority);
      }
    }
    for (const element of texted) {
      const nodes = textRuns(element.childNodes, (node) => this.texts.get(node) ?? node.data);
      for (const { run, value } of patch.text ?? []) {
        const node = nodes[run];
        if (!node) continue;
        if (!this.texts.has(node)) this.texts.set(node, node.data);
        node.data = value;
      }
    }
  }

  revert(): void {
    this.restore();
    this.originals.clear();
    this.texts.clear();
  }

  keep(): void {
    this.originals.clear();
    this.texts.clear();
  }

  private restore(): void {
    for (const [element, saved] of this.originals) {
      put(element, 'class', saved.className);
      put(element, 'style', saved.style);
    }
    for (const [node, data] of this.texts) node.data = data;
  }
}
