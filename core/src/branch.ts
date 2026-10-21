import type { Conversation, Message } from './types.ts';

// tree=true returns every branch (edits, retries): walk back from the visible leaf
export function getActiveBranch(conversation: Conversation): Message[] {
  const messages = conversation.chat_messages ?? [];
  const leaf = conversation.current_leaf_message_uuid;
  if (!leaf) return messages;

  const byId = new Map(messages.map(m => [m.uuid, m]));
  const branch: Message[] = [];
  const seen = new Set<string>();

  let cur = byId.get(leaf);
  while (cur && !seen.has(cur.uuid)) {
    seen.add(cur.uuid);
    branch.push(cur);
    cur = cur.parent_message_uuid ? byId.get(cur.parent_message_uuid) : undefined;
  }
  return branch.reverse();
}
