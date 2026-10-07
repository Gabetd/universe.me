import { describe, expect, it } from 'vitest'
import { compareVersions, pickUpdate, type UpdateManifest } from './update'

describe('compareVersions', () => {
  it('compares numerically, part by part', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0)
    expect(compareVersions('0.1.9', '0.1.10')).toBeLessThan(0)
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.2.0', '0.1.99')).toBeGreaterThan(0)
  })
})

describe('pickUpdate', () => {
  const file = { name: 'Universe-0.1.5-mac-arm64.zip', sha512: 'x', size: 1 }
  const manifest: UpdateManifest = { version: '0.1.5', commit: 'abc', files: { 'mac-zip-arm64': file } }
  it('offers the matching file only when the manifest is newer', () => {
    expect(pickUpdate(manifest, '0.1.4', 'mac-zip', 'arm64')).toBe(file)
    expect(pickUpdate(manifest, '0.1.5', 'mac-zip', 'arm64')).toBeUndefined()
    expect(pickUpdate(manifest, '0.1.4', 'mac-zip', 'x64')).toBeUndefined()
  })
})
