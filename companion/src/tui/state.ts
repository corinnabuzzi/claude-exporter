import type { ConversationSummary } from '@claude-exporter/core';

export type Job =
  | { status: 'queued' }
  | { status: 'running' }
  | { status: 'done'; dir: string; files: number; warnings: number }
  | { status: 'error'; message: string };

export interface State {
  chats: ConversationSummary[];
  loading: boolean;
  loadedCount: number;
  loadError: string | null;
  // index into the visible (filtered) list
  cursor: number;
  selected: ReadonlySet<string>;
  query: string;
  searching: boolean;
  queue: readonly string[];
  running: string | null;
  jobs: Readonly<Record<string, Job>>;
  message: string | null;
}

export type Action =
  | { type: 'load/start' }
  | { type: 'load/progress'; count: number }
  | { type: 'load/done'; chats: ConversationSummary[] }
  | { type: 'load/error'; message: string }
  | { type: 'cursor/move'; delta: number }
  | { type: 'cursor/edge'; edge: 'first' | 'last' }
  | { type: 'select/toggle' }
  | { type: 'select/all' }
  | { type: 'select/clear' }
  | { type: 'search/start' }
  | { type: 'search/type'; text: string }
  | { type: 'search/backspace' }
  | { type: 'search/end'; keep: boolean }
  | { type: 'export/queue' }
  | { type: 'job/start'; id: string }
  | { type: 'job/done'; id: string; dir: string; files: number; warnings: number }
  | { type: 'job/error'; id: string; message: string }
  | { type: 'message'; text: string | null };

export const initialState: State = {
  chats: [],
  loading: false,
  loadedCount: 0,
  loadError: null,
  cursor: 0,
  selected: new Set(),
  query: '',
  searching: false,
  queue: [],
  running: null,
  jobs: {},
  message: null
};

// every word must appear in the title, project or summary
export function visible(state: Pick<State, 'chats' | 'query'>): ConversationSummary[] {
  const words = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return state.chats;
  return state.chats.filter(chat => {
    const haystack = `${chat.name ?? ''} ${chat.project?.name ?? ''} ${chat.summary ?? ''}`.toLowerCase();
    return words.every(word => haystack.includes(word));
  });
}

export function current(state: State): ConversationSummary | undefined {
  return visible(state)[state.cursor];
}

const clamp = (n: number, length: number) => Math.max(0, Math.min(n, length - 1));

function withQuery(state: State, query: string): State {
  const next = { ...state, query };
  return { ...next, cursor: clamp(state.cursor, visible(next).length) };
}

function toggle(set: ReadonlySet<string>, ids: string[], on: boolean): Set<string> {
  const next = new Set(set);
  for (const id of ids) on ? next.add(id) : next.delete(id);
  return next;
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'load/start':
      return { ...state, loading: true, loadedCount: 0, loadError: null };
    case 'load/progress':
      return { ...state, loadedCount: action.count };
    case 'load/done': {
      // keep the selection only for chats that still exist
      const ids = new Set(action.chats.map(c => c.uuid));
      const selected = new Set([...state.selected].filter(id => ids.has(id)));
      const next = { ...state, chats: action.chats, loading: false, selected };
      return { ...next, cursor: clamp(state.cursor, visible(next).length) };
    }
    case 'load/error':
      return { ...state, loading: false, loadError: action.message };

    case 'cursor/move':
      return { ...state, cursor: clamp(state.cursor + action.delta, visible(state).length) };
    case 'cursor/edge':
      return { ...state, cursor: action.edge === 'first' ? 0 : clamp(Infinity, visible(state).length) };

    case 'select/toggle': {
      const chat = current(state);
      if (!chat) return state;
      return { ...state, selected: toggle(state.selected, [chat.uuid], !state.selected.has(chat.uuid)) };
    }
    case 'select/all': {
      // all visible already selected → unselect them, otherwise select them all
      const ids = visible(state).map(c => c.uuid);
      const allOn = ids.length > 0 && ids.every(id => state.selected.has(id));
      return { ...state, selected: toggle(state.selected, ids, !allOn) };
    }
    case 'select/clear':
      return { ...state, selected: new Set() };

    case 'search/start':
      return { ...state, searching: true };
    case 'search/type':
      return withQuery(state, state.query + action.text);
    case 'search/backspace':
      return withQuery(state, state.query.slice(0, -1));
    case 'search/end':
      return action.keep ? { ...state, searching: false } : { ...withQuery(state, ''), searching: false };

    case 'export/queue': {
      // selection wins; with nothing selected, export the chat under the cursor
      const targets = state.selected.size
        ? state.chats.filter(c => state.selected.has(c.uuid)).map(c => c.uuid)
        : [current(state)?.uuid].filter((id): id is string => Boolean(id));
      const busy = (id: string) => state.queue.includes(id) || state.running === id;
      const fresh = targets.filter(id => !busy(id));
      if (!fresh.length) return state;

      const jobs = { ...state.jobs };
      for (const id of fresh) jobs[id] = { status: 'queued' };
      return { ...state, queue: [...state.queue, ...fresh], jobs, selected: new Set() };
    }
    case 'job/start':
      return {
        ...state,
        queue: state.queue.filter(id => id !== action.id),
        running: action.id,
        jobs: { ...state.jobs, [action.id]: { status: 'running' } }
      };
    case 'job/done':
      return {
        ...state,
        running: null,
        jobs: {
          ...state.jobs,
          [action.id]: { status: 'done', dir: action.dir, files: action.files, warnings: action.warnings }
        }
      };
    case 'job/error':
      return {
        ...state,
        running: null,
        jobs: { ...state.jobs, [action.id]: { status: 'error', message: action.message } }
      };

    case 'message':
      return { ...state, message: action.text };
  }
}

export function progress(state: State): { done: number; failed: number; total: number } | null {
  const jobs = Object.values(state.jobs);
  if (!jobs.length) return null;
  return {
    done: jobs.filter(j => j.status === 'done').length,
    failed: jobs.filter(j => j.status === 'error').length,
    total: jobs.length
  };
}

export function busy(state: State): boolean {
  return state.running !== null || state.queue.length > 0;
}

// first row to draw so the cursor stays roughly centred and the list never shows empty space at the end
export function windowStart(cursor: number, length: number, height: number): number {
  if (length <= height) return 0;
  return Math.max(0, Math.min(cursor - Math.floor(height / 2), length - height));
}
