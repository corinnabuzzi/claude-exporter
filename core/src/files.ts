import { basename, fence } from './markdown.ts';
import {
  isToolResultBlock,
  str,
  toolInput,
  type Conversation,
  type ToolInput,
  type ToolUseBlock
} from './types.ts';

const TYPE_LANG: Record<string, string> = {
  'text/markdown': 'markdown',
  'text/html': 'html',
  'image/svg+xml': 'svg',
  'application/vnd.ant.mermaid': 'mermaid',
  'application/vnd.ant.react': 'jsx'
};

const SHELL_TOOLS = new Set(['bash_tool', 'Bash']);
const READ_TOOLS = new Set(['view', 'Read']);

export interface TrackedFile {
  path: string;
  content: string;
  skippedEdits: number;
  touchedByShell: boolean;
}

export interface FileTracker {
  // returns the inline marker for this tool call, or '' to show nothing
  handle(block: ToolUseBlock): string;
  files(): TrackedFile[];
  artifactUrls(): string[];
}

// the API flags failed calls on their tool_result; replaying those would apply edits that never happened
export function collectFailedCalls(conversation: Conversation): Set<string> {
  const failed = new Set<string>();
  for (const msg of conversation.chat_messages ?? []) {
    for (const block of msg.content ?? []) {
      if (isToolResultBlock(block) && block.is_error && block.tool_use_id) failed.add(block.tool_use_id);
    }
  }
  return failed;
}

// replays create_file + str_replace so the export gets final versions, not first drafts
export function createFileTracker(failedCalls: ReadonlySet<string> = new Set()): FileTracker {
  const files = new Map<string, TrackedFile>();
  const urls: string[] = [];
  let lastPath: string | undefined;

  function resolvePath(input: ToolInput): string | undefined {
    const path = str(input, 'path') ?? str(input, 'file_path');
    if (path) lastPath = path;
    return path ?? lastPath;
  }

  // same rule as str_replace: exactly one match, otherwise the real call failed too
  function applyEdit(file: TrackedFile, oldStr: string, newStr: string): void {
    const i = file.content.indexOf(oldStr);
    if (i === -1 || file.content.indexOf(oldStr, i + 1) !== -1) {
      file.skippedEdits++;
      return;
    }
    // slicing, not String.replace: new_str may contain $& and similar patterns
    file.content = file.content.slice(0, i) + newStr + file.content.slice(i + oldStr.length);
  }

  function noteShell(command: string): void {
    for (const [path, file] of files) {
      if (command.includes(path) || command.includes(basename(path))) file.touchedByShell = true;
    }
  }

  function artifactMarker(input: ToolInput): string {
    const action = str(input, 'action') ?? 'publish';
    if (action !== 'publish' && action !== 'open') return '';

    const url = str(input, 'url');
    if (url) {
      if (urls.includes(url)) return '';
      urls.push(url);
      return `*[Artifact: ${url}]*`;
    }
    return `*[Artifact published: ${str(input, 'title') ?? str(input, 'file_path') ?? 'untitled'}]*`;
  }

  function handle(block: ToolUseBlock): string {
    const name = block.name ?? '';
    const input = toolInput(block);

    if (name === 'Artifact') return artifactMarker(input);

    if (SHELL_TOOLS.has(name)) {
      noteShell(str(input, 'command') ?? '');
      return '';
    }

    const fileText = str(input, 'file_text');
    if (fileText !== undefined) {
      const path = resolvePath(input) ?? 'untitled';
      files.set(path, { path, content: fileText, skippedEdits: 0, touchedByShell: false });
      return `*[Created \`${path}\`]*`;
    }

    const oldStr = str(input, 'old_str');
    const newStr = str(input, 'new_str');
    if (oldStr !== undefined && newStr !== undefined) {
      const path = resolvePath(input) ?? str(input, 'id');
      const file = path ? files.get(path) : undefined;
      if (file && !(block.id && failedCalls.has(block.id))) applyEdit(file, oldStr, newStr);
      return `*[Edited \`${path ?? 'unknown file'}\`]*`;
    }

    // legacy artifacts tool: content inline in the call
    const content = str(input, 'content');
    if (content !== undefined && (name === 'artifacts' || input.command)) {
      const type = str(input, 'type');
      const lang = str(input, 'language') ?? (type ? TYPE_LANG[type] : undefined) ?? '';
      const title = str(input, 'title') ?? str(input, 'id') ?? 'untitled';
      return `**Artifact: ${title}**\n\n${fence(content, lang)}`;
    }

    if (READ_TOOLS.has(name)) resolvePath(input);
    return '';
  }

  return {
    handle,
    files: () => [...files.values()],
    artifactUrls: () => [...urls]
  };
}
