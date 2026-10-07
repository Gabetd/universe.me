import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // CI machines render WebGL in software, slowest on Windows.
  timeout: process.env.CI ? 120_000 : 60_000,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' }
})
