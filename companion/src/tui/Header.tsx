import { Box, Text } from 'ink';
import { fg } from '../format.ts';
import type { BrowserInfo } from '../hub.ts';

interface Props {
  browsers: BrowserInfo[];
  activeId: string | undefined;
}

export function Header({ browsers, activeId }: Props) {
  return (
    <Box justifyContent="space-between">
      <Text bold>claude-exporter</Text>
      <Box gap={2}>
        {browsers.length === 0 && <Text color="yellow">○ no browser</Text>}
        {browsers.map(b => {
          const active = b.id === activeId;
          const color = !b.account ? 'yellow' : active && 'green';
          return (
            <Text key={b.id} {...fg(color)} dimColor={!active && Boolean(b.account)}>
              {active ? '●' : '○'} {b.browser}
              {!b.account && ' (logged out)'}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}
