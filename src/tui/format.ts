/** Small pure string helpers shared by the panes. */

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function elapsedSince(startedAt: number | undefined, now: number): string {
  return startedAt === undefined ? '' : formatElapsed(now - startedAt);
}

/** Truncates with an ellipsis so a long slug can never push a row past its column. */
export function fit(value: string, width: number): string {
  if (width <= 0) return '';
  if (value.length <= width) return value;
  if (width === 1) return '…';
  return `${value.slice(0, width - 1)}…`;
}

export function padTo(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/** The part of a slug that is not already shown by its repo header. */
export function shortName(slug: string, alias?: string): string {
  if (alias) return alias;
  // Comparing against the raw repo name fails for anything not already
  // lowercase-hyphenated (TicketSolutions.Studio slugifies to
  // ticketsolutions-studio), and a slug's repo segment never contains a slash.
  const slash = slug.indexOf('/');
  return slash === -1 ? slug : slug.slice(slash + 1);
}
