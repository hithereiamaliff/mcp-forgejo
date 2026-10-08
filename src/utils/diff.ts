/**
 * Splitting and trimming unified diffs so large commits/PRs fit in a tool result.
 *
 * A diff is split per file ("diff --git a/x b/y"). Callers can keep only some
 * files, and the result is cut at a character budget with a list of the files
 * that were left out, so the model can ask for them specifically.
 */

export interface DiffFile {
  path: string;
  text: string;
}

export interface TrimmedDiff {
  text: string;
  files: string[];
  omitted: Array<{ path: string; chars: number }>;
  truncated: boolean;
}

/** Split a unified diff into per-file chunks. */
export function splitDiff(diff: string): DiffFile[] {
  const chunks = diff.split(/^(?=diff --git )/m).filter(c => c.trim());
  return chunks.map(text => {
    const header = /^diff --git a\/(.+?) b\/(.+?)$/m.exec(text);
    return { path: header ? header[2] : '(unknown)', text };
  });
}

/** True if `path` matches one of the filters (exact path, directory prefix, or "*" glob). */
export function pathMatches(path: string, filters: string[]): boolean {
  return filters.some(filter => {
    const f = filter.replace(/^\/+/, '');
    if (f.includes('*')) {
      const re = new RegExp(`^${f.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*')}$`);
      return re.test(path);
    }
    return path === f || path.startsWith(f.endsWith('/') ? f : `${f}/`);
  });
}

/** Keep the files matching `filters` (all if empty) and cut the result at `maxChars`. */
export function trimDiff(diff: string, maxChars: number, filters: string[] = []): TrimmedDiff {
  const files = splitDiff(diff).filter(f => !filters.length || pathMatches(f.path, filters));
  const kept: DiffFile[] = [];
  const omitted: TrimmedDiff['omitted'] = [];
  let used = 0;
  for (const file of files) {
    if (used + file.text.length <= maxChars) {
      kept.push(file);
      used += file.text.length;
    } else if (kept.length === 0 && used === 0) {
      // A single huge file: show its beginning rather than nothing.
      kept.push({ path: file.path, text: `${file.text.slice(0, maxChars)}\n... (diff of ${file.path} cut at ${maxChars} characters)\n` });
      used = maxChars;
      omitted.push({ path: `${file.path} (rest)`, chars: file.text.length - maxChars });
    } else {
      omitted.push({ path: file.path, chars: file.text.length });
    }
  }
  return {
    text: kept.map(f => f.text).join(''),
    files: kept.map(f => f.path),
    omitted,
    truncated: omitted.length > 0,
  };
}

/** Footer explaining what was left out of a trimmed diff. */
export function omittedNote(trimmed: TrimmedDiff, filterParam = 'files'): string {
  if (!trimmed.omitted.length) return '';
  const list = trimmed.omitted
    .slice(0, 40)
    .map(o => `${o.path} (${o.chars.toLocaleString('en-US')} chars)`)
    .join(', ');
  const more = trimmed.omitted.length > 40 ? ` and ${trimmed.omitted.length - 40} more` : '';
  return `_Diff truncated. Not shown: ${list}${more}. Call again with ${filterParam}=[...] to see specific files, or raise max_chars._`;
}
