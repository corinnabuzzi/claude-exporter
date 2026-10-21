const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number) => String(n).padStart(2, '0');

// fixed width so columns line up: "21 Oct 11:00", or "21 Oct 2025" for other years
export function shortDate(iso: string | undefined, now = new Date()): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const day = `${two(date.getDate())} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === now.getFullYear()
    ? `${day} ${two(date.getHours())}:${two(date.getMinutes())}`
    : `${day} ${date.getFullYear()}`;
}

// Ink's color prop can't be undefined under exactOptionalPropertyTypes: omit it instead
export function fg(color: string | false | undefined): { color?: string } {
  return color ? { color } : {};
}

export function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width);
}
