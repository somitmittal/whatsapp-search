/**
 * Pick the model download state the UI should display when multiple Ollama-backed
 * providers exist. Active work wins over terminal state from another provider.
 */
export function selectPullStatus(statuses) {
  const available = (statuses || []).filter(Boolean);
  return available.find((status) => status.status === 'downloading')
    ?? available.find((status) => status.status === 'error')
    ?? available.find((status) => status.status === 'done')
    ?? null;
}
