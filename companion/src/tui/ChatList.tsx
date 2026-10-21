import { Box, Text } from 'ink';
import type { ConversationSummary } from '@claude-exporter/core';
import { fg, shortDate, truncate } from '../format.ts';
import { Spinner } from './Spinner.tsx';
import { windowStart, type Job } from './state.ts';

interface Props {
  chats: ConversationSummary[];
  cursor: number;
  selected: ReadonlySet<string>;
  jobs: Readonly<Record<string, Job>>;
  width: number;
  height: number;
}

function JobMark({ job }: { job: Job | undefined }) {
  switch (job?.status) {
    case 'queued':
      return <Text dimColor>·</Text>;
    case 'running':
      return <Spinner />;
    case 'done':
      return <Text color={job.warnings ? 'yellow' : 'green'}>✓</Text>;
    case 'error':
      return <Text color="red">✗</Text>;
    default:
      return <Text> </Text>;
  }
}

export function ChatList({ chats, cursor, selected, jobs, width, height }: Props) {
  const start = windowStart(cursor, chats.length, height);
  const rows = chats.slice(start, start + height);

  // fixed columns: cursor 2, mark 2, star 2, date 14, project 15, job 2; the title takes the rest
  const showProject = width >= 72;
  const titleWidth = Math.max(10, width - 2 - 2 - 2 - 14 - (showProject ? 15 : 0) - 2);

  return (
    <Box flexDirection="column">
      {rows.map((chat, i) => {
        const index = start + i;
        const isCursor = index === cursor;
        const isSelected = selected.has(chat.uuid);
        return (
          <Box key={chat.uuid}>
            <Text color="cyan">{isCursor ? '› ' : '  '}</Text>
            <Text {...fg(isSelected && 'green')} dimColor={!isSelected}>
              {isSelected ? '◉ ' : '○ '}
            </Text>
            <Text color="yellow">{chat.is_starred ? '★ ' : '  '}</Text>
            <Text dimColor>{truncate(shortDate(chat.updated_at), 13)} </Text>
            {showProject && <Text color="magenta">{truncate(chat.project?.name ?? '', 14)} </Text>}
            <Text bold={isCursor} {...fg(isCursor && 'cyan')}>
              {truncate(chat.name || '(untitled)', titleWidth)}
            </Text>
            <Text> </Text>
            <JobMark job={jobs[chat.uuid]} />
          </Box>
        );
      })}
    </Box>
  );
}
