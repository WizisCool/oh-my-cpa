import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MANIFEST_NAME, SIGNATURE_NAME, createManifest, derivePublicKey, generateSigningKey, signManifest, verifyManifest, writeSignedManifest,
} from './sign-release-manifest.mjs';

const RELEASE = { tag: 'v1.2.3', image: 'wiziscool/oh-my-cpa', digest: `sha256:${'ab'.repeat(32)}` };

test('a manifest verifies only as signed and only for its own key', () => {
  const { privateKey, publicKey } = generateSigningKey();
  assert.equal(derivePublicKey(privateKey), publicKey);
  const manifest = createManifest(RELEASE);
  const signature = signManifest(manifest, privateKey);
  assert.ok(verifyManifest(manifest, signature, publicKey));
  assert.ok(!verifyManifest(manifest.replace('v1.2.3', 'v9.9.9'), signature, publicKey));
  assert.ok(!verifyManifest(manifest, signature, generateSigningKey().publicKey));
  assert.ok(!verifyManifest(manifest, signature, ''), 'An installation without a release key trusts nothing');
});

test('a manifest names one stable release and one image digest', () => {
  assert.deepEqual(JSON.parse(createManifest(RELEASE)), {
    schema: 1, version: 'v1.2.3', image: { repository: 'wiziscool/oh-my-cpa', digest: RELEASE.digest },
  });
  assert.throws(() => createManifest({ ...RELEASE, tag: 'v1.2.3-rc1' }));
  assert.throws(() => createManifest({ ...RELEASE, digest: 'latest' }));
  assert.throws(() => createManifest({ ...RELEASE, image: ' ' }));
});

test('publication stops when the signing secret is absent or is not the trusted key', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-manifest-'));
  try {
    const { privateKey, publicKey } = generateSigningKey();
    const environment = { RELEASE_TAG: RELEASE.tag, RELEASE_IMAGE: RELEASE.image, RELEASE_DIGEST: RELEASE.digest, RELEASE_SIGNING_KEY: privateKey };
    assert.throws(() => writeSignedManifest(directory, { ...environment, RELEASE_SIGNING_KEY: '' }, publicKey), /RELEASE_SIGNING_KEY is not set/);
    assert.throws(() => writeSignedManifest(directory, environment, generateSigningKey().publicKey), /does not match/);
    assert.throws(() => writeSignedManifest(directory, environment, ''), /does not match/);
    assert.deepEqual(fs.readdirSync(directory), [], 'A refused manifest leaves nothing to upload');

    writeSignedManifest(directory, environment, publicKey);
    const manifest = fs.readFileSync(path.join(directory, MANIFEST_NAME), 'utf8');
    const signature = fs.readFileSync(path.join(directory, SIGNATURE_NAME), 'utf8');
    assert.ok(verifyManifest(manifest, signature.trim(), publicKey));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
