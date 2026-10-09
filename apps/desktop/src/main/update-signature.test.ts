import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { UntrustedUpdate, readSignedManifest } from './update-signature'

const keyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { privateKey, x: publicKey.export({ format: 'jwk' }).x! }
}
const ours = keyPair()
const manifest = JSON.stringify({ version: '0.1.50', commit: 'abc1234', files: { 'mac-zip-arm64': { name: 'Universe-0.1.50-mac-arm64.zip', sha512: 'aGFzaA==', size: 10 } } })
const signed = (text: string, key = ours.privateKey) => JSON.stringify({ manifest: text, signature: sign(null, Buffer.from(text), key).toString('base64') })

describe('signed update manifests', () => {
  it('reads a manifest signed with the app’s key', () => {
    expect(readSignedManifest(signed(manifest), ours.x)).toEqual(JSON.parse(manifest))
  })

  it('refuses one signed with another key, a changed one, an unsigned one, and one it can’t read', () => {
    expect(() => readSignedManifest(signed(manifest, keyPair().privateKey), ours.x)).toThrow(UntrustedUpdate)
    const tampered = JSON.parse(signed(manifest)) as { manifest: string }
    tampered.manifest = tampered.manifest.replace('0.1.50', '0.1.51')
    expect(() => readSignedManifest(JSON.stringify(tampered), ours.x)).toThrow(/isn’t signed with Universe’s key/)
    expect(() => readSignedManifest(manifest, ours.x)).toThrow(/isn’t signed\./)
    expect(() => readSignedManifest('not json', ours.x)).toThrow(UntrustedUpdate)
    expect(() => readSignedManifest(signed('{"version":"latest"}'), ours.x)).toThrow(/can read/)
  })
})
