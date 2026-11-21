import type { TicketDetail } from '@guijam/contracts-ts';
import { describe, expect, it, vi } from 'vitest';
import {
  fileOfImage,
  isTicketKey,
  linkedTicket,
  loadingMessage,
  MAX_PROMPT,
  pageUrl,
  promptFromTicket,
  storedTicket,
  takeTicketParam,
} from './tracker';

const ref = { provider: 'jira', site: 'acme.atlassian.net', key: 'WEB-7' } as const;

describe('ticket keys and prompts', () => {
  it('accepts Jira keys in any case and rejects other text', () => {
    expect(isTicketKey('WEB-7')).toBe(true);
    expect(isTicketKey(' web-12 ')).toBe(true);
    expect(isTicketKey('WEB7')).toBe(false);
    expect(isTicketKey('make it blue')).toBe(false);
  });

  it('builds the prompt from the key, summary and description, within the prompt limit', () => {
    expect(promptFromTicket({ ref, summary: 'Make Subscribe blue', description: '' })).toBe(
      '[WEB-7] Make Subscribe blue',
    );
    expect(
      promptFromTicket({ ref, summary: 'Pill button', description: '  Match the brand.\n' }),
    ).toBe('[WEB-7] Pill button\n\nMatch the brand.');
    const long = promptFromTicket({ ref, summary: 'Long', description: 'x'.repeat(9000) });
    expect([...long]).toHaveLength(MAX_PROMPT);
  });
});

describe('page address and deep links', () => {
  it('leaves the ticket parameter out of the page address it reports', () => {
    expect(pageUrl({ href: 'http://localhost:5173/menu?guijam-ticket=WEB-7&tab=2' })).toBe(
      'http://localhost:5173/menu?tab=2',
    );
  });

  it('takes the ticket from the address bar once and cleans the address', () => {
    const history = { state: { page: 1 }, replaceState: vi.fn() };
    expect(
      takeTicketParam({ href: 'http://localhost:5173/?guijam-ticket=web-7#top' }, history),
    ).toBe('WEB-7');
    expect(history.replaceState).toHaveBeenCalledWith(
      { page: 1 },
      '',
      'http://localhost:5173/#top',
    );
    expect(takeTicketParam({ href: 'http://localhost:5173/' }, history)).toBeNull();
    expect(
      takeTicketParam({ href: 'http://localhost:5173/?guijam-ticket=%3Cscript%3E' }, history),
    ).toBeNull();
  });
});

describe('linked tickets', () => {
  const detail: TicketDetail = {
    ref,
    summary: 'Make Subscribe blue',
    description: 'Match the brand.',
    status: 'To Do',
    url: 'https://acme.atlassian.net/browse/WEB-7',
    images: [{ name: 'mock.png', mediaType: 'image/png' as const, base64: btoa('png-bytes') }],
    transitions: [{ id: '31', name: 'In Review' }],
  };

  it('starts with screenshots on and the ticket staying where it is', () => {
    const linked = linkedTicket(detail, [{ mediaType: 'image/jpeg', base64: 'AAAA' }]);
    expect(linked.screenshots).toBe(true);
    expect(linked.transitionId).toBeNull();
    expect(storedTicket(linked)).toEqual({ ...linked, images: [], before: [] });
    expect(storedTicket(null)).toBeNull();
  });

  it('turns a ticket image into a file the attachment pipeline accepts', async () => {
    const [image] = detail.images;
    if (!image) throw new Error('no image');
    const file = fileOfImage(image);
    expect(file.name).toBe('mock.png');
    expect(file.type).toBe('image/png');
    expect(await file.text()).toBe('png-bytes');
  });
});

describe('loading a ticket', () => {
  it('says what is happening at each step', () => {
    const at = (step: 'reading' | 'screenshot' | 'prompt', images = 0, fills = true) =>
      loadingMessage({ key: 'WEB-7', step, images, fills });
    expect(at('reading')).toBe('Reading WEB-7 from Jira…');
    expect(at('screenshot', 2)).toBe('Taking a before screenshot for WEB-7…');
    expect(at('prompt', 2)).toBe("Adding WEB-7's text and 2 images to your prompt…");
    expect(at('prompt', 1)).toBe("Adding WEB-7's text and 1 image to your prompt…");
    expect(at('prompt', 0)).toBe("Adding WEB-7's text to your prompt…");
    expect(at('prompt', 0, false)).toBe('Linking WEB-7…');
  });
});
