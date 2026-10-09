#!/usr/bin/env node
// Makes the key pair update manifests are signed with, once:
//   node scripts/update-key.mjs [--replace]
// Writes the public half into the app (apps/desktop/src/main/update-key.ts: commit it) and prints
// the private half, for the repository's UPDATE_SIGNING_KEY secret (GitHub → Settings → Secrets
// and variables → Actions → New repository secret). Keep no other copy of it.
// Replacing the key strands every copy installed with the old one: they refuse updates signed
// with the new key, and have to be downloaded again by hand.
import { generateKeyPairSync } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const keyFile = new URL('../apps/desktop/src/main/update-key.ts', import.meta.url)
const source = readFileSync(keyFile, 'utf8')
const current = source.match(/UPDATE_PUBLIC_KEY = '([\w-]*)'/)
if (!current) throw new Error(`no UPDATE_PUBLIC_KEY in ${keyFile.pathname}`)
if (current[1] && !process.argv.includes('--replace')) {
  console.error('update-key: the app already has a key. --replace makes a new one, and copies installed with the old one stop updating.')
  process.exit(1)
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
writeFileSync(keyFile, source.replace(current[0], `UPDATE_PUBLIC_KEY = '${publicKey.export({ format: 'jwk' }).x}'`))
process.stdout.write(`${privateKey.export({ type: 'pkcs8', format: 'pem' })}`)
console.error(`
update-key: the public half is in ${keyFile.pathname}: commit it.
The private half is above: paste all of it, BEGIN and END lines included, as the repository
secret UPDATE_SIGNING_KEY, then keep no other copy.`)
