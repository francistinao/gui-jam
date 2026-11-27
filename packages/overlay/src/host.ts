import type { GuijamMessage } from '@guijam/contracts-ts';

export type Tool = 'select' | 'draw' | 'history';

export interface WidgetHost {
  shadowRoot: ShadowRoot;
  hostElement: HTMLElement;
  request(message: { type: string; payload: object }): Promise<GuijamMessage>;
  onEvent(listener: (message: GuijamMessage) => void): () => void;
  onToolChange(tool: Tool | null): void;
  intercept(type: string, handler: (event: Event) => void): () => void;
}

export interface Widget {
  setTool(tool: Tool | null): void;
}

export interface WidgetModule {
  mount(host: WidgetHost): Widget;
}
