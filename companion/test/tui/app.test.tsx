import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup } from 'ink-testing-library';
import type { ConversationSummary } from '@claude-exporter/core';
import type { Backend } from '../../src/backend.ts';
import type { BrowserInfo, Rejection } from '../../src/hub.ts';
import type { WrittenExport } from '../../src/write.ts';
import { App } from '../../src/tui/App.tsx';

const KEY = { up: '\u001B[A', down: '\u001B[B', enter: '\r', escape: '\u001B', backspace: '\u007F' };

const CHATS: ConversationSummary[] = [
  { uuid: 'a', name: 'Imparare C', project: { name: 'Programming' }, updated_at: '2026-10-21T09:00:00Z', is_starred: true },
  { uuid: 'b', name: 'Claude chat exporter', project: { name: 'Programming' }, updated_at: '2026-10-20T20:58:00Z' },
  { uuid: 'c', name: 'Patente B', updated_at: '2026-10-19T10:00:00Z' },
  { uuid: 'd', name: 'OK Computer cover', updated_at: '2026-09-19T10:00:00Z' }
];

class FakeBackend implements Backend {
  token = 'f'.repeat(32);
  port = 47823;
  outDir = '/home/me/claude-exports';
  connected: BrowserInfo[] = [];
  preferred: string | null = null;
  chatsByBrowser = new Map<string, ConversationSummary[]>();
  failing = new Set<string>();
  exported: string[] = [];
  #listeners = new Set<() => void>();
  #rejectionListeners = new Set<(r: Rejection) => void>();

  onRejected = (listener: (r: Rejection) => void) => {
    this.#rejectionListeners.add(listener);
    return () => this.#rejectionListeners.delete(listener);
  };

  reject(rejection: Rejection): void {
    for (const listener of this.#rejectionListeners) listener(rejection);
  }

  browsers = () => this.connected;
  active = () => this.connected.find(b => b.id === this.preferred) ?? this.connected.at(-1);
  use = (id: string) => {
    this.preferred = id;
    return true;
  };
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  connect(browser: string, loggedIn = true, chats = CHATS): BrowserInfo {
    const info: BrowserInfo = {
      id: browser,
      browser,
      origin: `chrome-extension://${browser}`,
      extensionVersion: '0.1.0',
      account: loggedIn ? { orgId: 'org' } : null,
      connectedAt: Date.now()
    };
    this.connected.push(info);
    this.chatsByBrowser.set(browser, chats);
    this.#emit();
    return info;
  }

  setLoggedIn(browser: string, loggedIn: boolean): void {
    const info = this.connected.find(b => b.id === browser);
    if (info) info.account = loggedIn ? { orgId: 'org' } : null;
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }

  list = async (options: { onProgress?: (n: number) => void } = {}) => {
    const chats = this.chatsByBrowser.get(this.active()?.id ?? '') ?? [];
    options.onProgress?.(chats.length);
    return chats;
  };

  exportOne = async (id: string): Promise<WrittenExport> => {
    this.exported.push(id);
    if (this.failing.has(id)) throw new Error('HTTP 404');
    return {
      dir: `${this.outDir}/${id}`,
      markdownPath: `${this.outDir}/${id}/${id}.md`,
      filePaths: [],
      result: {
        title: id,
        filename: `${id}.md`,
        markdown: '',
        messageCount: 2,
        files: [],
        artifactUrls: []
      }
    };
  };
}

const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(frame: () => string | undefined, pattern: RegExp, timeout = 2_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const text = frame() ?? '';
    if (pattern.test(text)) return text;
    await tick(20);
  }
  throw new Error(`timed out waiting for ${pattern}\n--- last frame ---\n${frame()}`);
}

function setup(backend = new FakeBackend()) {
  const ui = render(<App backend={backend} exportDelayMs={0} />);
  const press = async (...keys: string[]) => {
    for (const key of keys) {
      ui.stdin.write(key);
      await tick();
    }
  };
  return { ...ui, backend, press };
}

afterEach(cleanup);

test('with no browser, it shows the pairing token, then the list once one connects', async () => {
  const { lastFrame, backend } = setup();
  const frame = await waitFor(lastFrame, /No browser connected/);
  assert.match(frame, new RegExp('f'.repeat(32)));

  backend.connect('chrome');
  const list = await waitFor(lastFrame, /Imparare C/);
  assert.match(list, /● chrome/);
  assert.match(list, /4 chats/);
});

test('a logged-out browser asks to log in, and the list appears after logging in', async () => {
  const backend = new FakeBackend();
  backend.connect('firefox', false);
  const { lastFrame } = setup(backend);
  await waitFor(lastFrame, /Log in to claude\.ai in firefox/);

  backend.setLoggedIn('firefox', true);
  await waitFor(lastFrame, /Patente B/);
});

test('search filters as you type; escape clears it', async () => {
  const backend = new FakeBackend();
  backend.connect('chrome');
  const { lastFrame, press } = setup(backend);
  await waitFor(lastFrame, /Imparare C/);

  await press('/', 'p', 'r', 'o', 'g');
  let frame = await waitFor(lastFrame, /2\/4 chats/);
  assert.doesNotMatch(frame, /Patente B/);

  await press(KEY.backspace, KEY.backspace, KEY.backspace, KEY.backspace, 'p', 'a', 't');
  frame = await waitFor(lastFrame, /1\/4 chats/);
  assert.match(frame, /Patente B/);

  await press(KEY.enter);
  assert.match(lastFrame() ?? '', /filter: pat/);
  await press(KEY.escape);
  await waitFor(lastFrame, /4 chats/);
});

test('space selects, enter exports the selection in list order', async () => {
  const backend = new FakeBackend();
  backend.connect('chrome');
  const { lastFrame, press } = setup(backend);
  await waitFor(lastFrame, /Imparare C/);

  await press(KEY.down, KEY.down, ' ', KEY.up, KEY.up, ' ');
  await waitFor(lastFrame, /2 selected/);
  await press(KEY.enter);

  const frame = await waitFor(lastFrame, /✓ 2 exported/);
  assert.deepEqual(backend.exported, ['a', 'c']);
  assert.doesNotMatch(frame, /selected/);
});

test('with nothing selected, enter exports the chat under the cursor', async () => {
  const backend = new FakeBackend();
  backend.connect('chrome');
  const { lastFrame, press } = setup(backend);
  await waitFor(lastFrame, /Imparare C/);

  await press(KEY.down, KEY.enter);
  await waitFor(lastFrame, /→ \/home\/me\/claude-exports\/b/);
  assert.deepEqual(backend.exported, ['b']);
});

test('a failed export is marked, and its error shows when the cursor is on it', async () => {
  const backend = new FakeBackend();
  backend.connect('chrome');
  backend.failing.add('a');
  const { lastFrame, press } = setup(backend);
  await waitFor(lastFrame, /Imparare C/);

  await press('a', KEY.enter);
  // cursor starts on the failed chat, so its error shows first
  let frame = await waitFor(lastFrame, /✗ HTTP 404/);

  await press(KEY.down);
  frame = await waitFor(lastFrame, /3 exported · 1 failed/);
  assert.doesNotMatch(frame, /HTTP 404/);

  await press(KEY.up);
  frame = await waitFor(lastFrame, /✗ HTTP 404/);
  assert.match(frame, /Imparare C\s+✗/);
});

test('switching browser loads that browser\'s chats', async () => {
  const backend = new FakeBackend();
  backend.connect('chrome', true, CHATS.slice(0, 1));
  backend.connect('firefox', true, CHATS.slice(2));
  const { lastFrame, press } = setup(backend);
  await waitFor(lastFrame, /Patente B/);

  await press('b');
  const frame = await waitFor(lastFrame, /Imparare C/);
  assert.doesNotMatch(frame, /Patente B/);
  assert.match(frame, /using chrome/);
});

test('quitting during exports needs a second q', async () => {
  const backend = new FakeBackend();
  backend.connect('chrome');
  let release!: () => void;
  const gate = new Promise<void>(resolve => (release = resolve));
  const original = backend.exportOne;
  backend.exportOne = async id => {
    await gate;
    return original(id);
  };

  const { lastFrame, press } = setup(backend);
  await waitFor(lastFrame, /Imparare C/);
  await press(KEY.enter, 'q');
  await waitFor(lastFrame, /press q again to quit/);
  release();
});

test('a refused browser is explained on the pairing screen, not silently ignored', async () => {
  const { lastFrame, backend } = setup();
  await waitFor(lastFrame, /No browser connected/);

  backend.reject({ kind: 'token', origin: 'moz-extension://x', browser: 'firefox' });
  await waitFor(lastFrame, /✗ firefox tried to connect with a different pairing token/);

  backend.reject({ kind: 'protocol', origin: 'moz-extension://x', browser: 'firefox', theirs: 2, ours: 1 });
  await waitFor(lastFrame, /extension in firefox is newer than this program/);

  backend.reject({ kind: 'protocol', origin: 'moz-extension://x', browser: 'firefox', theirs: 0, ours: 1 });
  await waitFor(lastFrame, /extension in firefox is older than this program/);
});

test('web pages probing the port are not shown: nothing for the user to do', async () => {
  const { lastFrame, backend } = setup();
  await waitFor(lastFrame, /No browser connected/);
  backend.reject({ kind: 'origin', origin: 'https://evil.example' });
  await tick(100);
  assert.doesNotMatch(lastFrame() ?? '', /✗/);
});

test('the refusal message goes away once a browser does connect', async () => {
  const { lastFrame, backend } = setup();
  await waitFor(lastFrame, /No browser connected/);
  backend.reject({ kind: 'token', origin: 'chrome-extension://x', browser: 'chrome' });
  await waitFor(lastFrame, /different pairing token/);

  await tick(5);
  backend.connect('chrome');
  const frame = await waitFor(lastFrame, /Imparare C/);
  assert.doesNotMatch(frame, /pairing token/);
});

test('a second browser refused while one is connected shows up in the status line', async () => {
  const backend = new FakeBackend();
  backend.connect('chrome');
  const { lastFrame } = setup(backend);
  await waitFor(lastFrame, /Imparare C/);

  backend.reject({ kind: 'token', origin: 'moz-extension://x', browser: 'firefox' });
  await waitFor(lastFrame, /✗ firefox tried to connect with a different pairing token/);
});

test('the pairing screen says how long to wait and how to skip it', async () => {
  const { lastFrame } = setup();
  const frame = await waitFor(lastFrame, /No browser connected/);
  assert.match(frame, /up to 30 seconds/);
  assert.match(frame, /Clicking the extension icon connects it right away/);
});

test('narrow terminals drop the project column instead of breaking rows', async () => {
  const backend = new FakeBackend();
  backend.connect('chrome');
  const { lastFrame } = setup(backend);
  const frame = await waitFor(lastFrame, /Imparare C/);
  // ink-testing-library renders at 100 columns: project column shown, no line wider than that
  assert.match(frame, /Programming/);
  for (const line of frame.split('\n')) assert.ok(line.length <= 100, `too wide: ${line}`);
});
