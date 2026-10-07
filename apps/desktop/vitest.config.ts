import { defineConfig } from 'vitest/config'

// Unit tests for the renderer's pure modules; e2e/ is Playwright's.
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } })
