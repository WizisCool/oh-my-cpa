import assert from 'node:assert/strict';
import test from 'node:test';

import { isValidVertexLocation, MAX_VERTEX_KEY_BYTES, readVertexKey } from '../web/src/components/authFiles/vertexImport.ts';

test('a service account key is summarised by its project and address only', () => {
  const reading = readVertexKey(JSON.stringify({
    type: 'service_account',
    project_id: ' acme-prod ',
    private_key: '-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----\n',
    client_email: 'runner@acme-prod.iam.gserviceaccount.com',
  }));
  assert.deepEqual(reading, { summary: { projectId: 'acme-prod', email: 'runner@acme-prod.iam.gserviceaccount.com' } });
  assert.equal(JSON.stringify(reading).includes('SECRET'), false);
});

test('a file that is not a service account key is refused with its reason', () => {
  assert.equal(readVertexKey('not json').problem, 'not_json');
  assert.equal(readVertexKey('[1]').problem, 'not_json');
  assert.equal(readVertexKey('{"type":"authorized_user","project_id":"p"}').problem, 'no_private_key');
  assert.equal(readVertexKey('{"private_key":"k"}').problem, 'no_project');
  assert.equal(readVertexKey(`{"private_key":"${'k'.repeat(MAX_VERTEX_KEY_BYTES)}"}`).problem, 'too_large');
});

test('a location is a region name or left empty', () => {
  for (const location of ['', '  ', 'us-central1', 'europe-west4', 'global']) {
    assert.equal(isValidVertexLocation(location), true, location);
  }
  for (const location of ['US-Central1', 'us central1', 'us-central1.evil.test', '1region', 'a'.repeat(41)]) {
    assert.equal(isValidVertexLocation(location), false, location);
  }
});
