// Mutual challenge-response over the pairing token. WebCrypto only, so the extension,
// Node and the Bun binary all run this exact code.

export type Role = 'program' | 'extension';

const NONCE_BYTES = 32;
const NONCE_RE = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

const toHex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

export function createNonce(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

export function isNonce(value: unknown): value is string {
  return typeof value === 'string' && NONCE_RE.test(value);
}

// The role label keeps the two proofs different: a fake program can't bounce the
// extension's own proof back to it (reflection), and a recorded proof is useless with new nonces.
function message(role: Role, extensionNonce: string, programNonce: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`chat-exporter/2|${role}|${extensionNonce}|${programNonce}`);
}

async function hmac(token: string, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign'
  ]);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

export async function makeProof(token: string, role: Role, extensionNonce: string, programNonce: string): Promise<string> {
  return toHex(await hmac(token, message(role, extensionNonce, programNonce)));
}

// compares every byte whatever happens, so timing doesn't reveal how much of a guess was right
export async function verifyProof(
  token: string,
  role: Role,
  extensionNonce: string,
  programNonce: string,
  proof: unknown
): Promise<boolean> {
  if (typeof proof !== 'string' || !token) return false;
  const expected = await makeProof(token, role, extensionNonce, programNonce);
  if (proof.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ proof.charCodeAt(i);
  return diff === 0;
}
