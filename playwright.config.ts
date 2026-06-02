import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  fullyParallel: true,
  reporter: 'list',
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
