import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportConversation } from '../src/index.ts';
import { linear, text, tool, toolError } from './helpers.ts';

const P = '/mnt/user-data/outputs/cap1.html';

function finalContent(conv: Parameters<typeof exportConversation>[0], path = P): string | undefined {
  return exportConversation(conv).files.find(f => f.path === path)?.content;
}

test('edits are replayed: the export has the final version, not the first draft', () => {
  const conv = linear([
    ['human', [text('make it')]],
    ['assistant', [tool('create_file', { path: P, file_text: '<p>A</p>\n<p>B</p>\n' })]],
    ['human', [text('fix it')]],
    ['assistant', [tool('str_replace', { path: P, old_str: '<p>A</p>', new_str: '<p>A2</p>' })]]
  ]);

  const { markdown, files } = exportConversation(conv);
  assert.equal(files[0]?.content, '<p>A2</p>\n<p>B</p>\n');
  assert.doesNotMatch(markdown, /<p>A<\/p>/);
  assert.match(markdown, /\*\[Created `\/mnt\/user-data\/outputs\/cap1\.html`\]\*/);
  assert.match(markdown, /\*\[Edited `\/mnt\/user-data\/outputs\/cap1\.html`\]\*/);
});

test('an edit without a path goes to the last file touched, including by view', () => {
  const conv = linear([
    ['assistant', [
      tool('create_file', { path: P, file_text: 'one' }),
      tool('create_file', { path: '/tmp/other.md', file_text: 'two' }),
      tool('view', { path: P }),
      tool('str_replace', { old_str: 'one', new_str: 'ONE' })
    ]]
  ]);
  assert.equal(finalContent(conv), 'ONE');
  assert.equal(finalContent(conv, '/tmp/other.md'), 'two');
});

test('replacement text is literal, so $& and friends survive', () => {
  const conv = linear([
    ['assistant', [
      tool('create_file', { path: P, file_text: 'price' }),
      tool('str_replace', { path: P, old_str: 'price', new_str: 'costs $&5 or $1' })
    ]]
  ]);
  assert.equal(finalContent(conv), 'costs $&5 or $1');
});

test('an edit with no match is skipped and later edits still apply', () => {
  const conv = linear([
    ['assistant', [
      tool('create_file', { path: P, file_text: 'hello' }),
      tool('str_replace', { path: P, old_str: 'NOPE', new_str: 'x' }),
      tool('str_replace', { path: P, old_str: 'hello', new_str: 'hello world' })
    ]]
  ]);
  const file = exportConversation(conv).files[0];
  assert.equal(file?.content, 'hello world');
  assert.equal(file?.skippedEdits, 1);
  assert.match(exportConversation(conv).markdown, /> ⚠ 1 edit had no unique match and was skipped/);
});

test('an ambiguous edit is skipped, like str_replace itself would refuse it', () => {
  const conv = linear([
    ['assistant', [
      tool('create_file', { path: P, file_text: '<p>a</p><p>b</p>' }),
      tool('str_replace', { path: P, old_str: '<p>', new_str: '<P>' })
    ]]
  ]);
  assert.equal(finalContent(conv), '<p>a</p><p>b</p>');
});

test('calls the API marked as errors are not replayed and not counted as skipped', () => {
  const conv = linear([
    ['assistant', [
      tool('create_file', { path: P, file_text: 'keep' }),
      tool('str_replace', { path: P, old_str: 'keep', new_str: 'FAILED CALL' }, 'call-1'),
      toolError('call-1'),
      tool('str_replace', { path: P, old_str: 'keep', new_str: 'retried' }, 'call-2')
    ]]
  ]);
  const file = exportConversation(conv).files[0];
  assert.equal(file?.content, 'retried');
  assert.equal(file?.skippedEdits, 0);
});

test('a shell command mentioning a tracked file flags it', () => {
  const conv = linear([
    ['assistant', [
      tool('create_file', { path: '/home/claude/notes.md', file_text: 'x' }),
      tool('bash_tool', { command: 'sed -i s/a/b/ notes.md', description: 'edit' })
    ]]
  ]);
  const { files, markdown } = exportConversation(conv);
  assert.equal(files[0]?.touchedByShell, true);
  assert.match(markdown, /A shell command also touched this file/);
});

test('re-creating a file replaces it rather than duplicating it', () => {
  const conv = linear([
    ['assistant', [
      tool('create_file', { path: P, file_text: 'v1' }),
      tool('create_file', { path: P, file_text: 'v2' })
    ]]
  ]);
  const { files } = exportConversation(conv);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.content, 'v2');
});

test('output names cannot point outside the files folder', () => {
  const conv = linear([
    ['assistant', [
      tool('create_file', { path: '/x/..', file_text: 'a' }),
      tool('create_file', { path: '/x/.', file_text: 'b' }),
      tool('create_file', { path: 'C:\\evil\\..\\run.bat', file_text: 'c' }),
      tool('create_file', { path: '/x/', file_text: 'd' })
    ]]
  ]);
  const names = exportConversation(conv).files.map(f => f.outputName);
  assert.deepEqual(names, ['file', 'file-2', 'C__evil_.._run.bat', 'file-3']);
  for (const name of names) assert.doesNotMatch(name, /[\\/]|^\.+$/);
});

test('embedFiles: false links files under unique names instead of inlining them', () => {
  const conv = linear([
    ['assistant', [
      tool('create_file', { path: '/a/notes.md', file_text: 'first' }),
      tool('create_file', { path: '/b/notes.md', file_text: 'second' })
    ]]
  ]);
  const { files, markdown } = exportConversation(conv, { embedFiles: false, filesDir: 'my files' });
  assert.deepEqual(files.map(f => f.outputName), ['notes.md', 'notes-2.md']);
  assert.match(markdown, /\[notes-2\.md\]\(<my files\/notes-2\.md>\)/);
  assert.doesNotMatch(markdown, /first|second/);
});
