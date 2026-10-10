/**
 * The public half of the Ed25519 key CI signs each update manifest with, as
 * its JWK `x` (base64url). `scripts/update-key.mjs` makes the pair once and
 * writes it here; the private half is the repository's UPDATE_SIGNING_KEY
 * secret. Empty, a copy installs no updates (it can't tell they're genuine).
 */
export const UPDATE_PUBLIC_KEY = '5qACQNuGePNMkJbDgvOq0J8q0xNCZDeW_D_SAA8FX8o'
