import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import type { Backend } from '../backend.ts';
import { ChatList } from './ChatList.tsx';
import { EmptyState, type EmptyKind } from './EmptyState.tsx';
import { Header } from './Header.tsx';
import { Spinner } from './Spinner.tsx';
import { busy, current, initialState, progress, reducer, visible, type State } from './state.ts';

export interface ExitSummary {
  exported: string[];
  failed: number;
}

interface Props {
  backend: Backend;
  // pause between exports, to be gentle with claude.ai
  exportDelayMs?: number;
}

// header, search bar, status line, key hints
const CHROME_ROWS = 5;

function summarize(state: State): ExitSummary {
  const jobs = Object.values(state.jobs);
  return {
    exported: jobs.flatMap(j => (j.status === 'done' ? [j.dir] : [])),
    failed: jobs.filter(j => j.status === 'error').length
  };
}

export function App({ backend, exportDelayMs = 300 }: Props) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const width = columns || 80;
  const height = Math.max(3, (rows || 24) - CHROME_ROWS);

  const [state, dispatch] = useReducer(reducer, initialState);
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const [quitArmed, setQuitArmed] = useState(false);
  const loadId = useRef(0);

  useEffect(() => backend.subscribe(refresh), [backend]);

  const browsers = backend.browsers();
  const active = backend.active();
  const loggedIn = Boolean(active?.account);
  const shown = visible(state);

  const load = useCallback(() => {
    const id = ++loadId.current;
    dispatch({ type: 'load/start' });
    backend
      .list({ onProgress: count => loadId.current === id && dispatch({ type: 'load/progress', count }) })
      .then(chats => loadId.current === id && dispatch({ type: 'load/done', chats }))
      .catch((err: Error) => loadId.current === id && dispatch({ type: 'load/error', message: err.message }));
  }, [backend]);

  // load as soon as a logged-in browser is there, and again when switching to another one
  useEffect(() => {
    if (loggedIn) load();
  }, [loggedIn, active?.id, load]);

  // one export at a time, in queue order
  useEffect(() => {
    const next = state.queue[0];
    if (!state.running && next) dispatch({ type: 'job/start', id: next });
  }, [state.running, state.queue]);

  // runs the current job; split from the effect above so starting a job can't cancel it
  useEffect(() => {
    const id = state.running;
    if (!id) return;
    const timer = setTimeout(() => {
      backend
        .exportOne(id)
        .then(w =>
          dispatch({
            type: 'job/done',
            id,
            dir: w.dir,
            files: w.result.files.length,
            warnings: w.result.files.filter(f => f.skippedEdits || f.touchedByShell).length
          })
        )
        .catch((err: Error) => dispatch({ type: 'job/error', id, message: err.message }));
    }, exportDelayMs);
    return () => clearTimeout(timer);
  }, [state.running, backend, exportDelayMs]);

  const switchBrowser = () => {
    if (browsers.length < 2) return dispatch({ type: 'message', text: 'only one browser connected' });
    const index = browsers.findIndex(b => b.id === active?.id);
    const next = browsers[(index + 1) % browsers.length];
    if (next && backend.use(next.id)) {
      dispatch({ type: 'message', text: `using ${next.browser}` });
      refresh();
    }
  };

  useInput((input, key) => {
    // a message lasts until the next key
    if (state.message) dispatch({ type: 'message', text: null });

    if (key.upArrow) return dispatch({ type: 'cursor/move', delta: -1 });
    if (key.downArrow) return dispatch({ type: 'cursor/move', delta: 1 });
    if (key.pageUp) return dispatch({ type: 'cursor/move', delta: -height });
    if (key.pageDown) return dispatch({ type: 'cursor/move', delta: height });
    if (key.home) return dispatch({ type: 'cursor/edge', edge: 'first' });
    if (key.end) return dispatch({ type: 'cursor/edge', edge: 'last' });

    if (state.searching) {
      if (key.escape) return dispatch({ type: 'search/end', keep: false });
      if (key.return) return dispatch({ type: 'search/end', keep: true });
      // terminals send either for the Backspace key
      if (key.backspace || key.delete) return dispatch({ type: 'search/backspace' });
      if (input && !key.ctrl && !key.meta && !/[\x00-\x1f]/.test(input)) {
        dispatch({ type: 'search/type', text: input });
      }
      return;
    }

    if (input !== 'q') setQuitArmed(false);

    switch (input) {
      case 'k':
        return dispatch({ type: 'cursor/move', delta: -1 });
      case 'j':
        return dispatch({ type: 'cursor/move', delta: 1 });
      case 'g':
        return dispatch({ type: 'cursor/edge', edge: 'first' });
      case 'G':
        return dispatch({ type: 'cursor/edge', edge: 'last' });
      case ' ':
        return dispatch({ type: 'select/toggle' });
      case 'a':
        return dispatch({ type: 'select/all' });
      case '/':
        return dispatch({ type: 'search/start' });
      case 'r':
        return loggedIn ? load() : undefined;
      case 'b':
        return switchBrowser();
      case 'q':
        if (busy(state) && !quitArmed) {
          setQuitArmed(true);
          return dispatch({ type: 'message', text: 'exports still running · press q again to quit anyway' });
        }
        return exit(summarize(state));
    }

    if (key.return) return dispatch({ type: 'export/queue' });
    if (key.escape) {
      return state.query
        ? dispatch({ type: 'search/end', keep: false })
        : dispatch({ type: 'select/clear' });
    }
  });

  let empty: EmptyKind | null = null;
  if (!browsers.length) empty = { kind: 'no-browser', token: backend.token, port: backend.port };
  else if (!loggedIn) empty = { kind: 'logged-out', browser: active?.browser ?? 'the browser' };
  else if (state.loading && !state.chats.length) empty = { kind: 'loading', count: state.loadedCount };
  else if (state.loadError && !state.chats.length) empty = { kind: 'error', message: state.loadError };
  else if (!state.chats.length && !state.loading) empty = { kind: 'no-chats' };
  else if (!shown.length) empty = { kind: 'no-match', query: state.query };

  return (
    <Box flexDirection="column" width={width} height={height + CHROME_ROWS}>
      <Header browsers={browsers} activeId={active?.id} />
      <SearchBar state={state} shown={shown.length} />
      <Box flexDirection="column" height={height} marginTop={1}>
        {empty ? (
          <EmptyState {...empty} />
        ) : (
          <ChatList
            chats={shown}
            cursor={state.cursor}
            selected={state.selected}
            jobs={state.jobs}
            width={width}
            height={height}
          />
        )}
      </Box>
      <StatusLine state={state} outDir={backend.outDir} />
      <KeyHints searching={state.searching} />
    </Box>
  );
}

function SearchBar({ state, shown }: { state: State; shown: number }) {
  const counts = `${shown}${state.query ? `/${state.chats.length}` : ''} chats${state.selected.size ? ` · ${state.selected.size} selected` : ''}`;
  return (
    <Box justifyContent="space-between">
      {state.searching ? (
        <Text>
          <Text color="cyan">/</Text> {state.query}
          <Text inverse> </Text>
        </Text>
      ) : state.query ? (
        <Text>
          <Text dimColor>filter:</Text> {state.query} <Text dimColor>(esc clears)</Text>
        </Text>
      ) : (
        <Text dimColor>/ to search</Text>
      )}
      {state.chats.length > 0 && (
        <Text dimColor>{state.loading ? 'refreshing… · ' : ''}{counts}</Text>
      )}
    </Box>
  );
}

function StatusLine({ state, outDir }: { state: State; outDir: string }) {
  const p = progress(state);
  const chat = current(state);
  const job = chat ? state.jobs[chat.uuid] : undefined;

  // a message answers the last key, so it beats progress
  if (state.message) return <Text color="yellow" wrap="truncate-end">{state.message}</Text>;

  if (state.running) {
    const name = state.chats.find(c => c.uuid === state.running)?.name ?? '';
    return (
      <Box gap={1}>
        <Spinner />
        <Text wrap="truncate-end">
          exporting {(p?.done ?? 0) + (p?.failed ?? 0) + 1}/{p?.total}: {name}
        </Text>
      </Box>
    );
  }
  if (job?.status === 'error') return <Text color="red" wrap="truncate-end">✗ {job.message}</Text>;

  const only = Object.values(state.jobs);
  const single = only.length === 1 ? only[0] : undefined;
  if (single?.status === 'done') {
    return (
      <Text wrap="truncate-end">
        <Text color="green">✓</Text> {single.files} files{single.warnings ? `, ${single.warnings} with warnings` : ''} → {single.dir}
      </Text>
    );
  }
  if (p) {
    return (
      <Text wrap="truncate-end">
        <Text color="green">✓ {p.done} exported</Text>
        {p.failed ? <Text color="red"> · {p.failed} failed</Text> : null} <Text dimColor>→ {outDir}</Text>
      </Text>
    );
  }
  return <Text dimColor wrap="truncate-end">exports go to {outDir}</Text>;
}

function KeyHints({ searching }: { searching: boolean }) {
  const hints = searching
    ? [['type', 'filter'], ['enter', 'done'], ['esc', 'clear'], ['↑↓', 'move']]
    : [['↑↓', 'move'], ['space', 'select'], ['a', 'all'], ['enter', 'export'], ['/', 'search'], ['r', 'reload'], ['b', 'browser'], ['q', 'quit']];
  return (
    <Text wrap="truncate-end">
      {hints.map(([k, label], i) => (
        <Text key={k}>
          {i > 0 && '  '}
          <Text color="cyan">{k}</Text> <Text dimColor>{label}</Text>
        </Text>
      ))}
    </Text>
  );
}
