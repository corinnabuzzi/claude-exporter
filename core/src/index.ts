import { getActiveBranch } from './branch.ts';
import { collectFailedCalls, createFileTracker, type FileTracker, type TrackedFile } from './files.ts';
import { basename, fence, formatTimestamp, langFromPath, sanitizeFilename } from './markdown.ts';
import { isTextBlock, isToolUseBlock, type Conversation, type Message } from './types.ts';

export { getActiveBranch } from './branch.ts';
export { collectFailedCalls, createFileTracker } from './files.ts';
export type { TrackedFile, FileTracker } from './files.ts';
export { fence, sanitizeFilename } from './markdown.ts';
export type * from './types.ts';
export { isTextBlock, isToolResultBlock, isToolUseBlock } from './types.ts';

export interface ExportOptions {
  locale?: string;
  // IANA name, e.g. "Europe/Rome"; defaults to the system time zone
  timeZone?: string;
  fallbackTitle?: string;
  // true: file contents go inside the markdown; false: links into filesDir
  embedFiles?: boolean;
  filesDir?: string;
}

export interface ExportedFile extends TrackedFile {
  // unique name to write the file under, when not embedded
  outputName: string;
}

export interface ExportResult {
  title: string;
  filename: string;
  markdown: string;
  messageCount: number;
  files: ExportedFile[];
  artifactUrls: string[];
}

interface RenderedMessage {
  sender: string;
  text: string;
  timestamp: string | null;
}

const UNTITLED = new Set(['', 'New conversation']);

export function exportConversation(conversation: Conversation, options: ExportOptions = {}): ExportResult {
  const {
    locale = 'en-US',
    timeZone,
    fallbackTitle = 'Claude conversation',
    embedFiles = true,
    filesDir = 'files'
  } = options;

  const tracker = createFileTracker(collectFailedCalls(conversation));

  const messages: RenderedMessage[] = getActiveBranch(conversation)
    .filter(msg => msg.sender === 'human' || msg.sender === 'assistant')
    .map(msg => ({
      sender: msg.sender as string,
      text: renderMessage(msg, tracker),
      timestamp: formatTimestamp(msg.created_at, locale, timeZone)
    }))
    .filter(msg => msg.text);

  const name = conversation.name?.trim() ?? '';
  const title = UNTITLED.has(name) ? fallbackTitle : name;
  const files = assignOutputNames(tracker.files());

  let markdown = `# ${title}\n\n`;
  for (const msg of messages) {
    const label = msg.sender === 'human' ? 'Human' : 'Claude';
    const header = msg.timestamp ? `## [${label}] ${msg.timestamp}` : `## [${label}]`;
    markdown += `${header}\n\n${msg.text}\n\n`;
  }
  markdown += renderFilesSection(files, embedFiles, filesDir);

  return {
    title,
    filename: `${sanitizeFilename(title) || 'claude_conversation'}.md`,
    markdown,
    messageCount: messages.length,
    files,
    artifactUrls: tracker.artifactUrls()
  };
}

function renderMessage(msg: Message, tracker: FileTracker): string {
  const parts: string[] = [];

  for (const block of msg.content ?? []) {
    if (isTextBlock(block)) {
      const text = block.text.trim();
      if (text) parts.push(text);
    } else if (isToolUseBlock(block)) {
      const marker = tracker.handle(block);
      if (marker) parts.push(marker);
    }
  }

  if (msg.sender === 'human') parts.push(...renderAttachments(msg));
  return parts.join('\n\n');
}

function renderAttachments(msg: Message): string[] {
  const parts = (msg.attachments ?? [])
    .filter(a => a.extracted_content)
    .map(a => `**Attachment: ${a.file_name ?? 'untitled'}**\n\n${fence(a.extracted_content ?? '')}`);

  const names = [...(msg.files ?? []), ...(msg.files_v2 ?? [])]
    .map(f => f.file_name)
    .filter((n): n is string => Boolean(n));
  if (names.length) parts.push(`*Files: ${[...new Set(names)].join(', ')}*`);

  return parts;
}

function renderFilesSection(files: ExportedFile[], embed: boolean, filesDir: string): string {
  if (files.length === 0) return '';

  let md = '## Files (final versions)\n\n';
  for (const file of files) {
    md += `### \`${file.path}\`\n\n`;
    if (file.skippedEdits) {
      const n = file.skippedEdits;
      md += `> ⚠ ${n} edit${n > 1 ? 's' : ''} had no unique match and ${n > 1 ? 'were' : 'was'} skipped. Usually a call that also failed in the chat and was retried.\n\n`;
    }
    if (file.touchedByShell) {
      md += '> ⚠ A shell command also touched this file: changes made that way are not included.\n\n';
    }
    md += embed
      ? `${fence(file.content, langFromPath(file.path))}\n\n`
      : `[${file.outputName}](<${filesDir}/${file.outputName}>)\n\n`;
  }
  return md;
}

// paths come from the model: never let one name a parent dir or escape filesDir
function safeName(path: string): string {
  const name = basename(path).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  return !name || /^\.+$/.test(name) ? 'file' : name;
}

function assignOutputNames(files: TrackedFile[]): ExportedFile[] {
  const used = new Set<string>();
  return files.map(file => {
    const base = safeName(file.path);
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';

    let name = base;
    for (let i = 2; used.has(name); i++) name = `${stem}-${i}${ext}`;
    used.add(name);
    return { ...file, outputName: name };
  });
}
