import type { GuijamMessage } from '@guijam/contracts-ts';

export type Tool = 'select';

/** What the plugin's browser client gives the widget when it loads it. */
export interface WidgetHost {
  /** The toolbar's shadow root; the widget renders and adopts its styles here. */
  shadowRoot: ShadowRoot;
  /** Element hosting the shadow root; events inside it belong to GUIJam, not the page. */
  hostElement: HTMLElement;
  /** Sends a widget request to the daemon (through the Vite plugin) and returns the reply. */
  request(message: { type: string; payload: object }): Promise<GuijamMessage>;
  /** Called when the widget leaves a tool on its own, e.g. on Escape. */
  onToolChange(tool: Tool | null): void;
}

export interface Widget {
  setTool(tool: Tool | null): void;
}

export interface WidgetModule {
  mount(host: WidgetHost): Widget;
}
