import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './sample-extensions',
  testMatch: '**/e2e/**/*.test.ts',
  timeout: 60_000,
  // One retry in CI to guard against flaky extension startup
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['github'], ['list']] : [['list']],
  // Tests manage their own browser context (required for chrome extension
  // launchPersistentContext setup). A single no-op project is required for
  // Playwright to discover and execute test files.
  projects: [{ name: 'chromium' }],
  outputDir: 'test-results',
});
