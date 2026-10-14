// Writes and signs the release manifest the updater verifies before it replaces the
// console (ADR 0099). The manifest names the image digest a release was published as;
// the signature is what lets an installation refuse an image the maintainers did not
// build, even when the release's tag or attachments were replaced.
//
//   node scripts/sign-release-manifest.mjs <output directory>
//     reads RELEASE_TAG, RELEASE_IMAGE, RELEASE_DIGEST and RELEASE_SIGNING_KEY
//   node scripts/sign-release-manifest.mjs --generate-key <private key file>
//     one-time setup: see docs/releasing.md
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Embedded into the Go binary, so the key a release is signed for and the key an
// installation trusts are one file.
export const PUBLIC_KEY_FILE = path.join(ROOT, 'internal/updater/release_public_key.txt');
export const MANIFEST_NAME = 'release-manifest.json';
export const SIGNATURE_NAME = 'release-manifest.json.sig';
const ED25519_KEY_BYTES = 32;

function loadPrivateKey(encoded) {
  assert.ok(encoded?.trim(), 'RELEASE_SIGNING_KEY is not set');
  const key = createPrivateKey({ key: Buffer.from(encoded.trim(), 'base64'), format: 'der', type: 'pkcs8' });
  assert.equal(key.asymmetricKeyType, 'ed25519', 'The release signing key must be an ed25519 key');
  return key;
}

/** The raw public half, base64, in the form the Go verifier reads. */
export function derivePublicKey(privateKey) {
  const der = createPublicKey(loadPrivateKey(privateKey)).export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - ED25519_KEY_BYTES).toString('base64');
}

export function generateSigningKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const encoded = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  return { privateKey: encoded, publicKey: derivePublicKey(encoded) };
}

export function createManifest({ tag, image, digest }) {
  assert.match(tag ?? '', /^v\d+\.\d+\.\d+$/, 'RELEASE_TAG must be a stable vMAJOR.MINOR.PATCH tag');
  assert.match(digest ?? '', /^sha256:[0-9a-f]{64}$/, 'RELEASE_DIGEST must be a sha256 image digest');
  assert.ok(image?.trim(), 'RELEASE_IMAGE is not set');
  // The signature covers these exact bytes; the verifier never re-serialises them.
  return `${JSON.stringify({ schema: 1, version: tag, image: { repository: image.trim(), digest } }, null, 2)}\n`;
}

export function signManifest(manifest, privateKey) {
  return sign(null, Buffer.from(manifest), loadPrivateKey(privateKey)).toString('base64');
}

export function verifyManifest(manifest, signature, publicKey) {
  const raw = Buffer.from(publicKey.trim(), 'base64');
  if (raw.length !== ED25519_KEY_BYTES) return false;
  // The fixed SPKI prefix of an ed25519 public key, so the raw key can be imported.
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
  return verify(null, Buffer.from(manifest), createPublicKey({ key: der, format: 'der', type: 'spki' }), Buffer.from(signature, 'base64'));
}

export function writeSignedManifest(directory, environment, trustedPublicKey) {
  const manifest = createManifest({ tag: environment.RELEASE_TAG, image: environment.RELEASE_IMAGE, digest: environment.RELEASE_DIGEST });
  const signature = signManifest(manifest, environment.RELEASE_SIGNING_KEY);
  // A release signed by a key no installation trusts would publish an update nobody
  // can apply, so the mismatch stops publication instead of surfacing in the field.
  assert.ok(verifyManifest(manifest, signature, trustedPublicKey),
    'RELEASE_SIGNING_KEY does not match internal/updater/release_public_key.txt');
  fs.writeFileSync(path.join(directory, MANIFEST_NAME), manifest);
  fs.writeFileSync(path.join(directory, SIGNATURE_NAME), `${signature}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [first, second] = process.argv.slice(2);
  if (first === '--generate-key') {
    assert.ok(second, 'Usage: sign-release-manifest.mjs --generate-key <private key file>');
    const { privateKey, publicKey } = generateSigningKey();
    fs.writeFileSync(second, `${privateKey}\n`, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(PUBLIC_KEY_FILE, `${publicKey}\n`);
    console.log(`Private key written to ${second}; store it as the RELEASE_SIGNING_KEY secret, then delete the file.`);
    console.log(`Public key written to ${path.relative(ROOT, PUBLIC_KEY_FILE)}; commit it.`);
  } else {
    assert.ok(first, 'Usage: sign-release-manifest.mjs <output directory>');
    writeSignedManifest(first, process.env, fs.readFileSync(PUBLIC_KEY_FILE, 'utf8'));
    console.log(`Signed ${MANIFEST_NAME} for ${process.env.RELEASE_TAG}`);
  }
}
