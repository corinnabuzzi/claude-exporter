import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
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

const mode = async (path: string) => (await stat(path)).mode & 0o777;
const unix = process.platform !== 'win32';

test('exports are readable only by their owner', { skip: !unix && 'POSIX permissions' }, async () => {
  const out = join(await mkdtemp(join(tmpdir(), 'export-')), 'claude-exports');
  const { dir, markdownPath, filePaths } = await writeExport(conversation, out);

  assert.equal(await mode(out), 0o700, 'the exports folder, when we create it');
  assert.equal(await mode(dir), 0o700);
  assert.equal(await mode(join(dir, 'files')), 0o700);
  for (const file of [markdownPath, join(dir, 'conversation.json'), ...filePaths]) {
    assert.equal(await mode(file), 0o600, file);
  }
});

test('re-exporting tightens files written by an older version', { skip: !unix && 'POSIX permissions' }, async () => {
  const out = await mkdtemp(join(tmpdir(), 'export-'));
  const { dir, markdownPath } = await writeExport(conversation, out);
  await chmod(dir, 0o755);
  await chmod(markdownPath, 0o644);

  await writeExport(conversation, out);
  assert.equal(await mode(dir), 0o700);
  assert.equal(await mode(markdownPath), 0o600);
});

test('an exports folder that already exists keeps the permissions the user gave it', { skip: !unix && 'POSIX permissions' }, async () => {
  const out = await mkdtemp(join(tmpdir(), 'export-'));
  await chmod(out, 0o750);
  await writeExport(conversation, out);
  assert.equal(await mode(out), 0o750);
});
