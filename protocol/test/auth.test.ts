import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createNonce, isNonce, makeProof, verifyProof } from '../src/auth.ts';

const TOKEN = 'a'.repeat(32);
const E = createNonce();
const P = createNonce();

test('nonces are 32 random bytes in hex, and never repeat', () => {
  const seen = new Set(Array.from({ length: 1000 }, createNonce));
  assert.equal(seen.size, 1000);
  for (const n of seen) assert.ok(isNonce(n));
  assert.ok(!isNonce('abc'));
  assert.ok(!isNonce('G'.repeat(64)));
  assert.ok(!isNonce(42));
});

test('a proof is a standard HMAC-SHA256, so any implementation can check it', async () => {
  const expected = createHmac('sha256', TOKEN).update(`chat-exporter/2|program|${E}|${P}`).digest('hex');
  assert.equal(await makeProof(TOKEN, 'program', E, P), expected);
});

test('the right token verifies', async () => {
  assert.ok(await verifyProof(TOKEN, 'program', E, P, await makeProof(TOKEN, 'program', E, P)));
  assert.ok(await verifyProof(TOKEN, 'extension', E, P, await makeProof(TOKEN, 'extension', E, P)));
});

test('a different token does not', async () => {
  const proof = await makeProof('b'.repeat(32), 'program', E, P);
  assert.ok(!(await verifyProof(TOKEN, 'program', E, P, proof)));
});

test('reflection: the extension\'s own proof is useless as a program proof', async () => {
  // a fake program that echoes back what it got can't pass as the program
  const extensionProof = await makeProof(TOKEN, 'extension', E, P);
  assert.ok(!(await verifyProof(TOKEN, 'program', E, P, extensionProof)));
});

test('replay: a recorded proof fails with a fresh nonce', async () => {
  const recorded = await makeProof(TOKEN, 'program', E, P);
  assert.ok(!(await verifyProof(TOKEN, 'program', createNonce(), P, recorded)));
  assert.ok(!(await verifyProof(TOKEN, 'program', E, createNonce(), recorded)));
});

test('swapping the two nonces gives a different proof', async () => {
  assert.notEqual(await makeProof(TOKEN, 'program', E, P), await makeProof(TOKEN, 'program', P, E));
});

test('garbage instead of a proof is just false, never an exception', async () => {
  for (const junk of [undefined, null, 42, '', 'zz', {}, 'a'.repeat(64)]) {
    assert.equal(await verifyProof(TOKEN, 'program', E, P, junk), false);
  }
  // an unset token never verifies anything, instead of reaching WebCrypto with an empty key
  assert.equal(await verifyProof('', 'program', E, P, 'a'.repeat(64)), false);
});
