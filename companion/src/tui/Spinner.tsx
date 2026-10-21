import { Text, useAnimation } from 'ink';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function Spinner({ color = 'cyan' }: { color?: string }) {
  const { frame } = useAnimation({ interval: 80 });
  return <Text color={color}>{FRAMES[frame % FRAMES.length]}</Text>;
}
