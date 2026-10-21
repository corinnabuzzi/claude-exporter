import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Conversation } from '@claude-exporter/core';
import { writeExport } from '../src/write.ts';

const conversation: Conversation = {
  uuid: '4da0e155-7e75-49f0-8533-4cd50c7383b5',
  name: 'Imparare C',
  current_leaf_message_uuid: 'b',
  chat_messages: [
    { uuid: 'a', parent_message_uuid: null, sender: 'human', content: [{ type: 'text', text: 'chapter 1 please' }] },
    {
      uuid: 'b',
      parent_message_uuid: 'a',
      sender: 'assistant',
      content: [
        { type: 'tool_use', name: 'create_file', input: { path: '/out/cap1.html', file_text: '<h1>Cap 1</h1>' } },
        { type: 'tool_use', name: 'create_file', input: { path: '/out/..', file_text: 'sneaky' } },
        { type: 'text', text: 'done' }
      ]
    }
  ]
};

test('writes a folder per chat: markdown, files, raw json', async () => {
  const out = await mkdtemp(join(tmpdir(), 'export-'));
  const written = await writeExport(conversation, out, { timeZone: 'UTC' });

  assert.equal(written.dir, join(out, 'imparare_c-4da0e155'));
  assert.deepEqual((await readdir(written.dir)).sort(), ['conversation.json', 'files', 'imparare_c.md']);
  assert.deepEqual((await readdir(join(written.dir, 'files'))).sort(), ['cap1.html', 'file']);

  const md = await readFile(written.markdownPath, 'utf8');
  assert.match(md, /\[cap1\.html\]\(<files\/cap1\.html>\)/);
  assert.doesNotMatch(md, /<h1>Cap 1<\/h1>/);
  assert.equal(await readFile(join(written.dir, 'files', 'cap1.html'), 'utf8'), '<h1>Cap 1</h1>');
  assert.deepEqual(JSON.parse(await readFile(join(written.dir, 'conversation.json'), 'utf8')), conversation);

  // nothing escaped the export folder
  assert.deepEqual((await readdir(out)).sort(), ['imparare_c-4da0e155']);
});

test('re-exporting the same chat overwrites the same folder', async () => {
  const out = await mkdtemp(join(tmpdir(), 'export-'));
  await writeExport(conversation, out);
  await writeExport({ ...conversation, name: 'Imparare C' }, out);
  assert.equal((await readdir(out)).length, 1);
});

test('saveRaw: false skips the json', async () => {
  const out = await mkdtemp(join(tmpdir(), 'export-'));
  const { dir } = await writeExport(conversation, out, { saveRaw: false });
  assert.ok(!(await readdir(dir)).includes('conversation.json'));
});
