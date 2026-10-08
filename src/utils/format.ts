/**
 * Small markdown helpers so every tool formats output the same way.
 */

/** True for values worth showing (skips null, undefined, empty strings and empty arrays). */
export function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** Escape text for a markdown table cell. */
export function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function table(headers: string[], rows: unknown[][]): string {
  const head = `| ${headers.map(cell).join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map(r => `| ${r.map(cell).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

/** "- **Label:** value" lines, skipping empty values. Arrays are joined with commas. */
export function bullets(entries: Array<[string, unknown]>): string {
  return entries
    .filter(([, v]) => hasValue(v))
    .map(([k, v]) => `- **${k}:** ${Array.isArray(v) ? v.join(', ') : v}`)
    .join('\n');
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * "2026-10-08T14:09:31+08:00" → "2026-10-08 06:09 UTC".
 * Forgejo uses "0001-01-01T00:00:00Z" for "never", which becomes an empty string.
 */
export function fmtDate(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1971) return '';
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** First 10 characters of a commit SHA. */
export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 10) : '';
}

/** First line of a commit message. */
export function firstLine(text: string | null | undefined): string {
  return (text ?? '').split(/\r?\n/, 1)[0].trim();
}

/** Cut text to `maxChars`, reporting whether anything was removed. */
export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

/** A code fence that can't be closed early by the content itself. */
export function fenceFor(content: string, char = '`'): string {
  let fence = char.repeat(3);
  while (content.includes(fence)) fence += char;
  return fence;
}

/** Wrap content in a fenced code block. */
export function codeBlock(content: string, language = ''): string {
  const fence = fenceFor(content);
  return `${fence}${language}\n${content}\n${fence}`;
}

/**
 * Show text written by other people (issue bodies, comments, wiki pages...)
 * inside a fence with its source, so the model treats it as data, not instructions.
 */
export function untrusted(content: string | null | undefined, source: string): string {
  const text = (content ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return `_${source}: (empty)_`;
  const fence = fenceFor(text, '~');
  return `${source}:\n${fence}markdown\n${text}\n${fence}`;
}

/** "1 issue" / "3 issues" */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatNumber(n)} ${n === 1 ? singular : pluralForm}`;
}

/** Human-readable byte size. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
