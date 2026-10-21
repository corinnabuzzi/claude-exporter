import { mkdir, writeFile } from 'node:fs/promises';
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

  const dir = join(outDir, exportDirName(result, conversation));
  await mkdir(dir, { recursive: true });

  const markdownPath = join(dir, result.filename);
  await writeFile(markdownPath, result.markdown);

  const filePaths: string[] = [];
  if (result.files.length) {
    const filesDir = join(dir, FILES_DIR);
    await mkdir(filesDir, { recursive: true });
    for (const file of result.files) {
      const path = join(filesDir, file.outputName);
      await writeFile(path, file.content);
      filePaths.push(path);
    }
  }

  if (saveRaw) await writeFile(join(dir, 'conversation.json'), JSON.stringify(conversation, null, 2));
  return { dir, markdownPath, filePaths, result };
}
