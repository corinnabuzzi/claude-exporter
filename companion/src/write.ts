import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportConversation, type Conversation, type ExportOptions, type ExportResult } from '@claude-exporter/core';

export interface WrittenExport {
  dir: string;
  markdownPath: string;
  filePaths: string[];
  result: ExportResult;
}

export interface WriteOptions extends Pick<ExportOptions, 'timeZone' | 'locale'> {
  // keep the raw JSON so a later version can re-render without fetching again
  saveRaw?: boolean;
}

const FILES_DIR = 'files';
// chats are private: other accounts on the same machine shouldn't be able to read them
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// mkdir's mode only applies to folders it creates; chmod also fixes ones from older versions
async function privateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIR_MODE });
  await chmod(path, DIR_MODE);
}

// writeFile keeps the old mode when it overwrites, so set it explicitly
async function privateFile(path: string, data: string): Promise<void> {
  await writeFile(path, data, { mode: FILE_MODE });
  await chmod(path, FILE_MODE);
}

// <out>/<title>-<id>/: the id suffix keeps folders stable across re-exports and unique across same-named chats
export function exportDirName(result: ExportResult, conversation: Conversation): string {
  const slug = result.filename.replace(/\.md$/, '');
  const id = (conversation.uuid ?? '').slice(0, 8);
  return id ? `${slug}-${id}` : slug;
}

export async function writeExport(
  conversation: Conversation,
  outDir: string,
  options: WriteOptions = {}
): Promise<WrittenExport> {
  const { saveRaw = true, ...exportOptions } = options;
  const result = exportConversation(conversation, { ...exportOptions, embedFiles: false, filesDir: FILES_DIR });

  // private if we create it; if it already exists, its permissions are the user's choice
  await mkdir(outDir, { recursive: true, mode: DIR_MODE });

  const dir = join(outDir, exportDirName(result, conversation));
  await privateDir(dir);

  const markdownPath = join(dir, result.filename);
  await privateFile(markdownPath, result.markdown);

  const filePaths: string[] = [];
  if (result.files.length) {
    const filesDir = join(dir, FILES_DIR);
    await privateDir(filesDir);
    for (const file of result.files) {
      const path = join(filesDir, file.outputName);
      await privateFile(path, file.content);
      filePaths.push(path);
    }
  }

  if (saveRaw) await privateFile(join(dir, 'conversation.json'), JSON.stringify(conversation, null, 2));
  return { dir, markdownPath, filePaths, result };
}
