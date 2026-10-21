// Real conversations, kept out of git (test/fixtures/private/).
// Each test skips when its fixture is missing, so a fresh clone still passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { exportConversation, getActiveBranch, isTextBlock } from '../src/index.ts';
import type { Conversation } from '../src/index.ts';
import { countHeaders } from './helpers.ts';

const dir = new URL('./fixtures/private/', import.meta.url);
const fixture = (name: string) => new URL(name, dir);
const has = (...names: string[]) => names.every(n => existsSync(fixture(n)));
const load = (name: string): Conversation => JSON.parse(readFileSync(fixture(name), 'utf8'));

test(
  'dispensa C chat: identical to the verified console export',
  { skip: !has('imparare-c.json', 'imparare-c.expected.md') && 'private fixture missing' },
  () => {
    const expected = readFileSync(fixture('imparare-c.expected.md'), 'utf8');
    const { markdown } = exportConversation(load('imparare-c.json'), { timeZone: 'Europe/Rome' });
    assert.equal(markdown, expected);
  }
);

test(
  'forked chat: only the active branch, nothing from abandoned edits',
  { skip: !has('exporter-chat.json') && 'private fixture missing' },
  () => {
    const conv = load('exporter-chat.json');
    const branch = getActiveBranch(conv);
    const onBranch = new Set(branch.map(m => m.uuid));
    const branchText = branch
      .flatMap(m => m.content ?? [])
      .filter(isTextBlock)
      .map(b => b.text)
      .join('\n');

    const { markdown, messageCount } = exportConversation(conv);
    assert.ok((conv.chat_messages?.length ?? 0) > branch.length, 'fixture should contain forks');
    assert.equal(countHeaders(markdown), messageCount);

    // edited prompts often share an opening with the kept version, so only check distinctive text
    const offBranch = (conv.chat_messages ?? [])
      .filter(m => !onBranch.has(m.uuid))
      .map(m => (m.content ?? []).find(isTextBlock)?.text.trim().slice(0, 80))
      .filter((s): s is string => Boolean(s && s.length >= 40 && !branchText.includes(s)));

    assert.ok(offBranch.length > 0, 'fixture should have distinctive abandoned text');
    for (const snippet of offBranch) assert.ok(!markdown.includes(snippet), `leaked: ${snippet}`);
  }
);
