// fence one backtick longer than any run inside, so nested code blocks survive
export function fence(content: string, lang = ''): string {
  let longest = 0;
  for (const run of content.match(/`+/g) ?? []) {
    if (run.length > longest) longest = run.length;
  }
  const ticks = '`'.repeat(Math.max(2, longest) + 1);
  return `${ticks}${lang}\n${content.replace(/\n+$/, '')}\n${ticks}`;
}

export function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

export function langFromPath(path: string | undefined): string {
  const name = path ? basename(path) : '';
  return name.includes('.') ? (name.split('.').pop() ?? '') : '';
}

export function formatTimestamp(iso: string | undefined, locale: string, timeZone?: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {})
  });
}

export function sanitizeFilename(title: string): string {
  return title
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .substring(0, 100);
}
