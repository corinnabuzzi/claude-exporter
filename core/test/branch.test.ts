import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportConversation, getActiveBranch } from '../src/index.ts';
import { chat, msg, text } from './helpers.ts';

test('follows parents back from the leaf, skipping retries and edits', () => {
  const conv = chat([
    msg('h1', null, 'human', [text('question')]),
    msg('a1-retry', 'h1', 'assistant', [text('ABANDONED retry')]),
    msg('a1', 'h1', 'assistant', [text('answer')]),
    msg('h2-edit', 'a1', 'human', [text('ABANDONED edit')]),
    msg('h2', 'a1', 'human', [text('follow-up')])
  ]);

  assert.deepEqual(getActiveBranch(conv).map(m => m.uuid), ['h1', 'a1', 'h2']);
  assert.doesNotMatch(exportConversation(conv).markdown, /ABANDONED/);
});

test('without a leaf, falls back to every message in order', () => {
  const conv = chat([msg('a', null, 'human', [text('one')]), msg('b', 'a', 'assistant', [text('two')])]);
  conv.current_leaf_message_uuid = null;
  assert.deepEqual(getActiveBranch(conv).map(m => m.uuid), ['a', 'b']);
});

test('a parent cycle does not hang', () => {
  const conv = chat([msg('a', 'b', 'human', [text('one')]), msg('b', 'a', 'assistant', [text('two')])]);
  assert.deepEqual(getActiveBranch(conv).map(m => m.uuid), ['a', 'b']);
});

test('a leaf that is not in the messages gives an empty branch', () => {
  const conv = chat([msg('a', null, 'human', [text('one')])]);
  conv.current_leaf_message_uuid = 'missing';
  assert.equal(getActiveBranch(conv).length, 0);
  assert.equal(exportConversation(conv).messageCount, 0);
});
