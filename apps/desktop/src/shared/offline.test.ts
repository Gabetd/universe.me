import { describe, expect, it } from 'vitest'
import { isAllowedRequest } from './offline'

describe('isAllowedRequest', () => {
  it('lets the app load itself', () => {
    expect(isAllowedRequest('file:///app/out/renderer/index.html', true)).toBe(true)
    expect(isAllowedRequest('blob:file:///1234', true)).toBe(true)
  })

  it('blocks the pages from reaching the internet, even the update hosts', () => {
    expect(isAllowedRequest('https://example.com/collect', true)).toBe(false)
    expect(isAllowedRequest('https://github.com/Gabetd/universe.me/releases/download/latest-build/update.json', true)).toBe(false)
    expect(isAllowedRequest('wss://example.com', true)).toBe(false)
  })

  it('lets only the updater, in the main process, download releases', () => {
    expect(isAllowedRequest('https://github.com/Gabetd/universe.me/releases/download/latest-build/update.json', false)).toBe(true)
    expect(isAllowedRequest('https://github.com/someone-else/repo', false)).toBe(false)
    expect(isAllowedRequest('https://example.com', false)).toBe(false)
  })

  it('allows extra origins for the dev server and tests', () => {
    expect(isAllowedRequest('http://localhost:5173/src/main.tsx', true, ['http://localhost:5173/'])).toBe(true)
    expect(isAllowedRequest('http://localhost:9999/', true, ['http://localhost:5173/'])).toBe(false)
  })
})
