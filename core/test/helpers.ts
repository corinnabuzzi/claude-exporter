import type { ContentBlock, Conversation, Message } from '../src/types.ts';

let clock = Date.parse('2026-10-20T10:00:00Z');

export function msg(
  uuid: string,
  parent: string | null,
  sender: 'human' | 'assistant',
  content: ContentBlock[],
  extra: Partial<Message> = {}
): Message {
  clock += 60_000;
  return {
    uuid,
    parent_message_uuid: parent,
    sender,
    created_at: new Date(clock).toISOString(),
    content,
    ...extra
  };
}

export function text(value: string): ContentBlock {
  return { type: 'text', text: value };
}

export function tool(name: string, input: Record<string, unknown>, id?: string): ContentBlock {
  return id ? { type: 'tool_use', id, name, input } : { type: 'tool_use', name, input };
}

export function toolError(toolUseId: string): ContentBlock {
  return { type: 'tool_result', tool_use_id: toolUseId, is_error: true, content: [] };
}

// chains messages parent → child in order, leaf = last
export function chat(messages: Message[], name = 'Test chat'): Conversation {
  const last = messages.at(-1);
  return { uuid: 'conv', name, current_leaf_message_uuid: last?.uuid ?? null, chat_messages: messages };
}

export function linear(turns: Array<['human' | 'assistant', ContentBlock[]]>, name?: string): Conversation {
  const messages: Message[] = [];
  turns.forEach(([sender, content], i) => {
    messages.push(msg(`m${i}`, i ? `m${i - 1}` : null, sender, content));
  });
  return chat(messages, name);
}

// message headers outside fenced code blocks, so exported files don't count
export function countHeaders(markdown: string): number {
  let fenceLen = 0;
  let count = 0;
  for (const line of markdown.split('\n')) {
    const open = line.match(/^(`{3,})/);
    if (open?.[1]) {
      const len = open[1].length;
      if (!fenceLen) fenceLen = len;
      else if (len >= fenceLen && /^`+$/.test(line)) fenceLen = 0;
      continue;
    }
    if (!fenceLen && /^## \[(Human|Claude)\]/.test(line)) count++;
  }
  return count;
}
