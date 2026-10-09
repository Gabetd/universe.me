#!/usr/bin/env node
// Signs the update manifest for the app's self-updater (apps/desktop/src/main/update-signature.ts):
//   UPDATE_SIGNING_KEY=<private key, PEM> node scripts/sign-update.mjs <update.json> [public key]
// Writes { manifest, signature }: the manifest's text and an Ed25519 signature of it. It fails,
// writing nothing, without the key, or with a key whose public half isn't the one the app checks
// with (apps/desktop/src/main/update-key.ts, or the public key given, as a JWK `x`): a build
// signed with any other key would be refused by every installed copy.
import { createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'

const [file, given] = process.argv.slice(2)
if (!file) throw new Error('usage: sign-update.mjs <update.json> [public key]')
const fail = (message) => {
  console.error(`sign-update: ${message}`)
  process.exit(1)
}

const pem = process.env.UPDATE_SIGNING_KEY
if (!pem) fail('no UPDATE_SIGNING_KEY: add it as a repository secret (node scripts/update-key.mjs makes one)')
const key = createPrivateKey(pem)
if (key.asymmetricKeyType !== 'ed25519') fail(`UPDATE_SIGNING_KEY is an ${key.asymmetricKeyType} key, not Ed25519`)

const keyFile = new URL('../apps/desktop/src/main/update-key.ts', import.meta.url)
const expected = given ?? readFileSync(keyFile, 'utf8').match(/UPDATE_PUBLIC_KEY = '([\w-]*)'/)?.[1]
const x = createPublicKey(key).export({ format: 'jwk' }).x
if (x !== expected) fail(`the signing key's public half (${x}) isn't the one the app checks with (${expected || 'none yet'})`)

const manifest = readFileSync(file, 'utf8')
process.stdout.write(JSON.stringify({ manifest, signature: sign(null, Buffer.from(manifest), key).toString('base64') }) + '\n')
