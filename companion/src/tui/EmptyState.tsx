import { Box, Text } from 'ink';
import { Spinner } from './Spinner.tsx';

export type EmptyKind =
  | { kind: 'no-browser'; token: string; port: number }
  | { kind: 'logged-out'; browser: string }
  | { kind: 'loading'; count: number }
  | { kind: 'error'; message: string }
  | { kind: 'no-chats' }
  | { kind: 'no-match'; query: string };

export function EmptyState(props: EmptyKind) {
  switch (props.kind) {
    case 'no-browser':
      return (
        <Box flexDirection="column" gap={1} paddingLeft={2}>
          <Text color="yellow">No browser connected.</Text>
          <Box flexDirection="column">
            <Text>1. Load the extension (extension/dist) in Chrome or Firefox</Text>
            <Text>2. Open its popup and paste this pairing token:</Text>
          </Box>
          <Box paddingLeft={3}>
            <Text bold color="cyan">{props.token}</Text>
            <Text dimColor>   port {props.port}</Text>
          </Box>
          <Text dimColor>This screen updates by itself once the browser connects.</Text>
        </Box>
      );
    case 'logged-out':
      return (
        <Box paddingLeft={2}>
          <Text color="yellow">Log in to claude.ai in {props.browser}: the list loads by itself afterwards.</Text>
        </Box>
      );
    case 'loading':
      return (
        <Box paddingLeft={2} gap={1}>
          <Spinner />
          <Text>Loading conversations…{props.count ? ` ${props.count}` : ''}</Text>
        </Box>
      );
    case 'error':
      return (
        <Box flexDirection="column" paddingLeft={2}>
          <Text color="red">✗ {props.message}</Text>
          <Text dimColor>press r to retry</Text>
        </Box>
      );
    case 'no-chats':
      return (
        <Box paddingLeft={2}>
          <Text dimColor>No conversations in this account yet.</Text>
        </Box>
      );
    case 'no-match':
      return (
        <Box paddingLeft={2}>
          <Text dimColor>No chats match “{props.query}”. Esc clears the search.</Text>
        </Box>
      );
  }
}
