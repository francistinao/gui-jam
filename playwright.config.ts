import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

process.env.GUIJAM_E2E_CONFIG_HOME ??= join(tmpdir(), `guijam-e2e-config-${process.pid}`);
process.env.XDG_CONFIG_HOME = process.env.GUIJAM_E2E_CONFIG_HOME;
process.env.APPDATA = process.env.GUIJAM_E2E_CONFIG_HOME;

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
