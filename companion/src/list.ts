import type { ConversationPage, ConversationSummary } from '@claude-exporter/core';

export type FetchPage = (offset: number, limit: number) => Promise<unknown>;

export interface ListOptions {
  max?: number;
  pageSize?: number;
  delayMs?: number;
  onProgress?: (count: number) => void;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function readPage(raw: unknown): { items: ConversationSummary[]; hasMore: boolean | undefined } {
  if (Array.isArray(raw)) return { items: raw as ConversationSummary[], hasMore: undefined };
  const page = (raw ?? {}) as ConversationPage;
  return { items: Array.isArray(page.data) ? page.data : [], hasMore: page.has_more };
}

// stops on has_more: false, an empty page, or a page with nothing new,
// so an endpoint that ignores offset can't loop forever
export async function listConversations(fetchPage: FetchPage, options: ListOptions = {}): Promise<ConversationSummary[]> {
  const { max = Infinity, pageSize = 50, delayMs = 250, onProgress } = options;
  const seen = new Set<string>();
  const out: ConversationSummary[] = [];
  let offset = 0;

  while (out.length < max) {
    if (offset > 0 && delayMs) await sleep(delayMs);
    const limit = Math.min(pageSize, max - out.length);
    const { items, hasMore } = readPage(await fetchPage(offset, limit));

    let added = 0;
    for (const item of items) {
      if (!item?.uuid || seen.has(item.uuid)) continue;
      seen.add(item.uuid);
      out.push(item);
      added++;
      if (out.length >= max) break;
    }

    onProgress?.(out.length);
    if (added === 0 || hasMore === false) break;
    // without has_more, a short page is the only end signal; with it, a short page may just be a server cap
    if (hasMore === undefined && items.length < limit) break;
    offset += items.length;
  }
  return out;
}
