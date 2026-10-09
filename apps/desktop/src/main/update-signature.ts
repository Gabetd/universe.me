import { createPublicKey, verify } from 'node:crypto'
import { z } from 'zod'
import type { UpdateManifest } from '../shared/update'

/**
 * Reads a signed update manifest, as CI publishes it (scripts/sign-update.mjs):
 * the manifest's own text, and an Ed25519 signature of that text by the key
 * whose public half is in the app (update-key.ts). Only a manifest that checks
 * out is read, and it names each installer's size and SHA-512, so nothing but
 * what CI built and signed is installed, whoever gets to change the release.
 */

const Signed = z.object({ manifest: z.string(), signature: z.string() })
const Manifest = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  commit: z.string(),
  files: z.record(z.string(), z.object({ name: z.string(), sha512: z.string(), size: z.number().int().min(0) }))
})

/** A manifest that isn't signed by the app's key, or can't be read. */
export class UntrustedUpdate extends Error {}

/** The manifest in `body` (a signed manifest's JSON), if it's signed by `publicKey` (a JWK `x`); throws UntrustedUpdate if not. */
export function readSignedManifest(body: string, publicKey: string): UpdateManifest {
  const signed = Signed.safeParse(parse(body))
  if (!signed.success) throw new UntrustedUpdate('The latest build’s manifest isn’t signed.')
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' })
  const { manifest, signature } = signed.data
  if (!verify(null, Buffer.from(manifest), key, Buffer.from(signature, 'base64'))) {
    throw new UntrustedUpdate('The latest build isn’t signed with Universe’s key, so this copy won’t install it.')
  }
  const read = Manifest.safeParse(parse(manifest))
  if (!read.success) throw new UntrustedUpdate('The latest build’s manifest isn’t one this copy can read.')
  return read.data
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
