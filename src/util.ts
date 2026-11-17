// Small shared helpers: deterministic logical clock, opaque global ids, diffs.

/** A logical clock: every timestamp comes from a counter, never the wall clock, so two
 * runs that serve the same requests in the same order produce the same timestamps. */
export class LogicalClock {
  #tick = 0;
  readonly #baseMs: number;
  constructor(baseIso = '2026-01-01T00:00:00.000Z') {
    this.#baseMs = Date.parse(baseIso);
  }
  /** Next ISO timestamp, one second after the previous one. */
  nowIso(): string {
    this.#tick += 1;
    return new Date(this.#baseMs + this.#tick * 1000).toISOString();
  }
  /** Next Unix epoch seconds, one second after the previous one. */
  nowSec(): number {
    this.#tick += 1;
    return Math.floor(this.#baseMs / 1000) + this.#tick;
  }
}

/** Opaque Relay-style global id: base64url of "<Type>:<key>". */
export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64url');
}

/** Parse a global id back into [type, key], or null. */
export function parseGlobalId(id: string): [string, string] | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return [text.slice(0, colon), text.slice(colon + 1)];
  } catch {
    return null;
  }
}

/** Cursor for connection pagination: base64url of the zero-based index. */
export function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

export function indexOfCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number(text.slice('cursor:'.length));
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/** Count added/removed lines between two texts with a simple LCS diff. */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  // Strip one trailing empty element when the text ends with a newline, so a final
  // newline is not counted as a line of its own.
  if (a.length && a[a.length - 1] === '') a.pop();
  if (b.length && b[b.length - 1] === '') b.pop();
  const n = a.length;
  const m = b.length;
  if (n === 0) return { additions: m, deletions: 0 };
  if (m === 0) return { additions: 0, deletions: n };
  // LCS lengths, two rows.
  let prev = new Array<number>(m + 1).fill(0);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
    cur.fill(0);
  }
  const common = prev[m] as number;
  return { additions: m - common, deletions: n - common };
}

/** Remove trailing newlines from a commit message for display (GitHub trims them). */
export function displayMessage(message: string): string {
  return message.replace(/\n+$/, '');
}
