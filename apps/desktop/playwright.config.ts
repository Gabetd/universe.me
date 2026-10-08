import { defineConfig } from '@playwright/test'

const CI = !!process.env.CI

export default defineConfig({
  testDir: './e2e',
  // CI machines render WebGL in software, slowest on Windows.
  timeout: CI ? 120_000 : 60_000,
  expect: { timeout: CI ? 15_000 : 5_000 },
  workers: 1,
  reporter: 'list',
  // For Electron apps this keeps only the test runner's own log of the steps (no DOM snapshots
  // or screencast), a few KB per test: cheap enough to have for every failure.
  use: { trace: 'retain-on-failure' }
})
