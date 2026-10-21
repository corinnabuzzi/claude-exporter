import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportConversation, fence, sanitizeFilename } from '../src/index.ts';
import { chat, linear, msg, text, tool } from './helpers.ts';

test('title comes from the conversation name, with a fallback for untitled chats', () => {
  assert.equal(exportConversation(linear([['human', [text('hi')]]], '  Dispensa C  ')).title, 'Dispensa C');
  assert.equal(exportConversation(linear([['human', [text('hi')]]], 'New conversation')).title, 'Claude conversation');
  assert.equal(
    exportConversation(linear([['human', [text('hi')]]], ''), { fallbackTitle: 'Untitled' }).title,
    'Untitled'
  );
});

test('filename is sanitized from the title', () => {
  assert.equal(sanitizeFilename('Dispensa C: capitolo 1/2?'), 'dispensa_c_capitolo_1_2');
  assert.equal(exportConversation(linear([['human', [text('hi')]]], '???')).filename, 'claude_conversation.md');
});

test('headers use the requested time zone', () => {
  const conv = chat([msg('a', null, 'human', [text('hi')], { created_at: '2026-10-20T20:58:00Z' })]);
  assert.match(exportConversation(conv, { timeZone: 'Europe/Rome' }).markdown, /## \[Human\] Oct 20, 2026, 10:58 PM/);
  assert.match(exportConversation(conv, { timeZone: 'UTC' }).markdown, /## \[Human\] Oct 20, 2026, 8:58 PM/);
});

test('a missing or broken timestamp gives a bare header', () => {
  const conv = chat([msg('a', null, 'human', [text('hi')], { created_at: 'not a date' })]);
  assert.match(exportConversation(conv).markdown, /## \[Human\]\n/);
});

test('text blocks around tool calls are kept in order; unknown tools leave no trace', () => {
  const conv = linear([
    ['assistant', [
      text('before'),
      tool('web_search', { query: 'q' }),
      tool('Claude Docs:update', { payload: '{}' }),
      text('after')
    ]]
  ]);
  assert.match(exportConversation(conv).markdown, /before\n\nafter/);
});

test('messages that render to nothing are dropped', () => {
  const conv = linear([
    ['human', [text('question')]],
    ['assistant', [tool('web_search', { query: 'q' })]],
    ['assistant', [text('   ')]]
  ]);
  assert.equal(exportConversation(conv).messageCount, 1);
});

test('artifacts become one link each, and only for publish/open', () => {
  const url = 'https://claude.ai/code/artifact/1';
  const conv = linear([
    ['assistant', [
      tool('Artifact', { action: 'open', url }),
      tool('Artifact', { action: 'open', url }),
      tool('Artifact', { action: 'list' }),
      tool('Artifact', { file_path: 'page.html' })
    ]]
  ]);
  const { markdown, artifactUrls } = exportConversation(conv);
  assert.deepEqual(artifactUrls, [url]);
  assert.equal(markdown.split(url).length, 2);
  assert.match(markdown, /\*\[Artifact published: page\.html\]\*/);
  assert.doesNotMatch(markdown, /list/);
});

test('the legacy artifacts tool is inlined with a language from its type', () => {
  const conv = linear([
    ['assistant', [tool('artifacts', { command: 'create', title: 'Demo', type: 'text/html', content: '<b>x</b>' })]]
  ]);
  assert.match(exportConversation(conv).markdown, /\*\*Artifact: Demo\*\*\n\n```html\n<b>x<\/b>\n```/);
});

test('human attachments are fenced safely and file names listed once', () => {
  const conv = chat([
    msg('a', null, 'human', [text('see attached')], {
      attachments: [{ file_name: 'notes.md', extracted_content: 'has ```code``` inside' }],
      files: [{ file_name: 'img.png' }],
      files_v2: [{ file_name: 'img.png' }]
    }),
    msg('b', 'a', 'assistant', [text('ok')], { attachments: [{ file_name: 'ignored', extracted_content: 'no' }] })
  ]);
  const { markdown } = exportConversation(conv);
  assert.match(markdown, /\*\*Attachment: notes\.md\*\*\n\n````\nhas ```code``` inside\n````/);
  assert.match(markdown, /\*Files: img\.png\*/);
  assert.doesNotMatch(markdown, /ignored/);
});

test('fence trims trailing newlines and outgrows inner backtick runs', () => {
  assert.equal(fence('a\n\n', 'js'), '```js\na\n```');
  assert.equal(fence('x ````` y'), '``````\nx ````` y\n``````');
});

test('garbage tool inputs do not crash the export', () => {
  const conv = linear([
    ['assistant', [
      { type: 'tool_use', name: 'create_file', input: null },
      { type: 'tool_use', name: 'str_replace', input: 'nonsense' },
      { type: 'tool_use', input: { file_text: 42 } },
      text('still here')
    ]]
  ]);
  assert.match(exportConversation(conv).markdown, /still here/);
});
