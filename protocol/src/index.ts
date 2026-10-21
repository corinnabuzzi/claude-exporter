// Wire format between the extension and the companion: JSON text frames over a
// WebSocket on 127.0.0.1. Bump PROTOCOL_VERSION on any incompatible change.
//
// Handshake (protocol 2). The token never crosses the wire, and the program proves itself first:
//   extension → hello      { nonce: E }
//   program   → challenge  { nonce: P, proof: HMAC(token, "program" E P) }
//   extension: checks the proof; only then →
//   extension → proof      { proof: HMAC(token, "extension" E P), account }
//   program   → welcome    (or close BadToken)

export { createNonce, isNonce, makeProof, verifyProof, type Role } from './auth.ts';

export const PROTOCOL_VERSION = 2;
export const DEFAULT_PORT = 47823;

export const CloseCode = {
  BadToken: 4001,
  BadMessage: 4002,
  ProtocolMismatch: 4004,
  Shutdown: 4005,
  // sent by the extension when the other side couldn't prove it knows the token
  ProgramUnverified: 4006
} as const;

// never carries the session cookie: only proof that one exists
export interface Account {
  orgId: string;
}

export type Operation =
  | { op: 'list'; offset: number; limit: number }
  | { op: 'conversation'; conversationId: string };

export type ErrorCode = 'not_logged_in' | 'bad_request' | 'http' | 'unreachable';
export type Via = 'background' | 'tab';

// extension → companion

export interface HelloMessage {
  type: 'hello';
  protocol: number;
  nonce: string;
  browser: string;
  extensionVersion: string;
}

export interface ProofMessage {
  type: 'proof';
  proof: string;
  account: Account | null;
}

export interface AccountMessage {
  type: 'account';
  account: Account | null;
}

export interface PingMessage {
  type: 'ping';
}

export type ResponseMessage =
  | { type: 'response'; id: string; ok: true; via: Via; result: unknown }
  | { type: 'response'; id: string; ok: false; code: ErrorCode; error: string };

export type ExtensionMessage = HelloMessage | ProofMessage | AccountMessage | PingMessage | ResponseMessage;

// companion → extension

export interface ChallengeMessage {
  type: 'challenge';
  nonce: string;
  proof: string;
}

export interface WelcomeMessage {
  type: 'welcome';
  clientId: string;
}

export type RequestMessage = { type: 'request'; id: string } & Operation;

export type CompanionMessage = ChallengeMessage | WelcomeMessage | RequestMessage;

// sent as the close reason on ProtocolMismatch, so the extension knows which side is outdated
export function mismatchReason(companionProtocol: number): string {
  return `protocol ${companionProtocol}`;
}

export function parseMismatchReason(reason: string): number | null {
  const n = Number(reason.match(/^protocol (\d+)$/)?.[1]);
  return Number.isInteger(n) ? n : null;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// shape check only: enough to route a message, not a full validator
export function parseMessage(raw: string): { type: string; [key: string]: unknown } | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' ? (value as { type: string }) : null;
}
