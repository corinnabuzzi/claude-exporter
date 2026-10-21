import { DEFAULT_PORT } from '@claude-exporter/protocol';
import type { State } from './background.ts';

const CLAUDE = { origins: ['https://claude.ai/*'] };
const LABELS: Record<State, string> = {
  idle: 'Not paired',
  connecting: 'Connecting…',
  connected: 'Connected to the program',
  offline: 'Program not reachable',
  rejected: 'Pairing token rejected',
  outdated: 'Update needed'
};

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
}

interface Status {
  state: State;
  detail: string;
  loggedIn: boolean;
}

async function refreshStatus(): Promise<void> {
  const res = (await chrome.runtime.sendMessage({ type: 'status' }).catch(() => null)) as Status | null;
  const state = res?.state ?? 'idle';
  $('status').dataset.state = state;
  $('label').textContent = LABELS[state];
  $('detail').textContent = res?.detail ?? '';

  const loggedIn = res?.loggedIn ?? false;
  $('account').dataset.ok = String(loggedIn);
  $('account-label').textContent = loggedIn ? 'Logged in to claude.ai' : 'Not logged in to claude.ai';
}

async function refreshPermission(): Promise<void> {
  $('permission').hidden = await chrome.permissions.contains(CLAUDE);
}

$('grant').addEventListener('click', async () => {
  await chrome.permissions.request(CLAUDE);
  await refreshPermission();
});

$('pairing').addEventListener('submit', async e => {
  e.preventDefault();
  const port = Number($<HTMLInputElement>('port').value) || DEFAULT_PORT;
  const token = $<HTMLInputElement>('token').value.trim();
  const stored = await chrome.storage.local.get(['port', 'token']);
  await chrome.storage.local.set({ port, token });
  // a real change reconnects through storage.onChanged; this covers "retry with the same token"
  if (stored.port === port && stored.token === token) {
    await chrome.runtime.sendMessage({ type: 'reconnect' }).catch(() => {});
  }
  await refreshStatus();
});

async function init(): Promise<void> {
  const stored = await chrome.storage.local.get(['port', 'token']);
  $<HTMLInputElement>('port').value = String(typeof stored.port === 'number' ? stored.port : DEFAULT_PORT);
  $<HTMLInputElement>('token').value = typeof stored.token === 'string' ? stored.token : '';
  await refreshPermission();
  await refreshStatus();
  setInterval(() => void refreshStatus(), 1_000);
}

void init();
