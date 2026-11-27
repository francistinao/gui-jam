import type { Locator } from '@playwright/test';

export async function openSection(panel: Locator, name: string): Promise<Locator> {
  const section = panel.getByRole('region', { name, exact: true });
  if ((await section.locator('details').getAttribute('open')) === null) {
    await section.locator('summary').click();
  }
  return section;
}
