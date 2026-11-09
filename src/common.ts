import {MAX_TABLE_ROWS} from './constants.js';

export function formatBytes(bytes: number): string {
  if (bytes === 0 || Number.isNaN(bytes)) return '0 B';
  const absBytes = Math.abs(bytes);
  if (absBytes < 1) return `${bytes} B`;
  const k = 1000;
  const sizes = ['B', 'kB', 'MB', 'GB', 'TB'];
  const rawIndex = Math.floor(Math.log(absBytes) / Math.log(k));
  const i = Math.min(Math.max(rawIndex, 0), sizes.length - 1);
  const byteValue = parseFloat((absBytes / Math.pow(k, i)).toFixed(1));
  return `${bytes < 0 ? -byteValue : byteValue} ${sizes[i]}`;
}

export function formatBytesSigned(bytes: number): string {
  return `${bytes > 0 ? '+' : ''}${formatBytes(bytes)}`;
}

export function pluralize(
  count: number,
  singular: string,
  plural = `${singular}s`
): string {
  return `${count} ${Math.abs(count) === 1 ? singular : plural}`;
}

/**
 * Strips terminal control characters, ANSI sequences, and zero-width / bidi characters
 * from remote strings before rendering them in logs or Markdown.
 */
export function sanitizeText(input: string): string {
  return input
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '');
}

export function escapeMarkdownCell(input: string): string {
  return sanitizeText(input)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

export function parseCommaList(input: string | undefined): string[] {
  if (!input) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.split(',')) {
    const trimmed = raw.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

/**
 * Matches a package name against an exact name or simple wildcard pattern (e.g. `@types/*`, `eslint-*`).
 */
export function matchesPattern(value: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) {
    return value === pattern;
  }
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

export function matchesAnyPattern(
  value: string,
  patterns: Iterable<string>
): boolean {
  for (const pattern of patterns) {
    if (matchesPattern(value, pattern)) {
      return true;
    }
  }
  return false;
}

export function formatTableWithCollapse(
  headerLines: string,
  rows: string[],
  maxRows = MAX_TABLE_ROWS,
  itemNoun = 'package'
): string {
  if (rows.length <= maxRows) {
    return `${headerLines}\n${rows.join('\n')}`;
  }

  const visibleRows = rows.slice(0, maxRows);
  const hiddenRows = rows.slice(maxRows);
  const remainingText = pluralize(hiddenRows.length, `more ${itemNoun}`);

  return `${headerLines}
${visibleRows.join('\n')}

<details>
<summary>and ${remainingText}</summary>

${headerLines}
${hiddenRows.join('\n')}

</details>`;
}

export async function mapConcurrent<T, R>(
  items: Iterable<T>,
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const list = Array.from(items);
  if (list.length === 0) return [];
  const results = new Array<R>(list.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < list.length) {
      const current = nextIndex++;
      results[current] = await fn(list[current]);
    }
  }

  const workerCount = Math.min(Math.max(concurrency, 1), list.length);
  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}
