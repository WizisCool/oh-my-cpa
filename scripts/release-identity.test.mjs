import test from 'node:test';
import assert from 'node:assert/strict';
import { assertReleaseIdentity } from './release-identity.mjs';
const revision = 'a'.repeat(40);
const input = {tag:'v0.1.3',revision,repository:'owner/repo',head:revision};
test('lightweight and annotated tag resolution binds checkout and publication', () => {
  assertReleaseIdentity({...input,resolve:()=>({object:{type:'commit',sha:revision}})});
  const calls=[];
  assertReleaseIdentity({...input,resolve: endpoint=>{calls.push(endpoint);return {object: calls.length===1?{type:'tag',sha:'b'.repeat(40)}:{type:'commit',sha:revision}};}});
  assert.equal(calls.length,2);
  assert.throws(()=>assertReleaseIdentity({...input,head:'b'.repeat(40),resolve:()=>assert.fail('must not resolve')}));
  assert.throws(()=>assertReleaseIdentity({...input,resolve:()=>({object:{type:'commit',sha:'b'.repeat(40)}})}));
  assert.throws(()=>assertReleaseIdentity({...input,resolve:()=>({object:{type:'tag',sha:revision}})}));
  assert.throws(()=>assertReleaseIdentity({...input,tag:'v1.0.0\nother',resolve:()=>assert.fail()}));
});
