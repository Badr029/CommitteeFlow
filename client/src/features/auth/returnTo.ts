export function returnToFromState(state: unknown): string {
  const candidate = (state as { returnTo?: unknown } | null)?.returnTo;
  return typeof candidate === 'string' && candidate.startsWith('/') && !candidate.startsWith('//')
    ? candidate
    : '/plan';
}
