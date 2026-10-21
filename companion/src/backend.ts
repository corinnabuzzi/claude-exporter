import type { ConversationSummary, Conversation } from '@claude-exporter/core';
import type { BrowserInfo, Hub } from './hub.ts';
import { listConversations } from './list.ts';
import { writeExport, type WrittenExport } from './write.ts';

// what the TUI needs from the outside world; tests swap in a fake
export interface Backend {
  readonly token: string;
  readonly port: number;
  readonly outDir: string;
  browsers(): BrowserInfo[];
  active(): BrowserInfo | undefined;
  use(id: string): boolean;
  // called on any browser connect, disconnect or login change
  subscribe(listener: () => void): () => void;
  list(options?: { max?: number; onProgress?: (count: number) => void }): Promise<ConversationSummary[]>;
  exportOne(conversationId: string): Promise<WrittenExport>;
}

export interface BackendOptions {
  token: string;
  outDir: string;
}

export function createBackend(hub: Hub, { token, outDir }: BackendOptions): Backend {
  return {
    token,
    outDir,
    port: hub.port,
    browsers: () => hub.browsers(),
    active: () => hub.active(),
    use: id => hub.use(id),

    subscribe(listener) {
      hub.on('connected', listener);
      hub.on('disconnected', listener);
      hub.on('account', listener);
      return () => {
        hub.off('connected', listener);
        hub.off('disconnected', listener);
        hub.off('account', listener);
      };
    },

    async list(options = {}) {
      const fetchPage = async (offset: number, limit: number) =>
        (await hub.request({ op: 'list', offset, limit })).result;
      return listConversations(fetchPage, options);
    },

    async exportOne(conversationId) {
      const { result } = await hub.request({ op: 'conversation', conversationId });
      return writeExport(result as Conversation, outDir);
    }
  };
}
