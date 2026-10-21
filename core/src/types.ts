// Shapes of claude.ai's internal conversation API, as observed in real exports.
// Nothing here is documented, so almost everything is optional and tool inputs
// stay `unknown` until a helper checks them.

export interface Conversation {
  uuid?: string;
  name?: string;
  current_leaf_message_uuid?: string | null;
  chat_messages?: Message[];
}

export interface Message {
  uuid: string;
  parent_message_uuid?: string | null;
  sender?: string;
  created_at?: string;
  content?: ContentBlock[];
  attachments?: Attachment[];
  files?: FileRef[];
  files_v2?: FileRef[];
}

export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface TextBlock extends ContentBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock extends ContentBlock {
  type: 'tool_use';
  id?: string;
  name?: string;
  input?: unknown;
}

export interface ToolResultBlock extends ContentBlock {
  type: 'tool_result';
  tool_use_id?: string;
  is_error?: boolean;
}

export interface Attachment {
  file_name?: string;
  extracted_content?: string;
}

export interface FileRef {
  file_name?: string;
}

// one entry of chat_conversations_v2
export interface ConversationSummary {
  uuid: string;
  name?: string;
  summary?: string;
  model?: string;
  created_at?: string;
  updated_at?: string;
  is_starred?: boolean;
  is_archived?: boolean;
  is_temporary?: boolean;
  project_uuid?: string | null;
  project?: { uuid?: string; name?: string } | null;
  platform?: string;
}

export interface ConversationPage {
  data?: ConversationSummary[];
  has_more?: boolean;
}

export type ToolInput = Record<string, unknown>;

export function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === 'text' && typeof block.text === 'string';
}

export function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === 'tool_use';
}

export function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  return block.type === 'tool_result';
}

export function toolInput(block: ToolUseBlock): ToolInput {
  const { input } = block;
  return typeof input === 'object' && input !== null ? (input as ToolInput) : {};
}

export function str(input: ToolInput, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}
