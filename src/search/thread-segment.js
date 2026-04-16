/** Shared thread segmentation — must match daily-summary indexing. */

const THREAD_GAP_SECONDS = 30 * 60;
const MIN_THREAD_MESSAGES = 3;

/**
 * Splits a chronologically-sorted message array into conversation threads.
 * @param {Array<{ timestamp: number }>} messages
 */
export function segmentIntoThreads(messages, gapSeconds = THREAD_GAP_SECONDS) {
  if (messages.length === 0) return [];

  const rawThreads = [];
  let current = [messages[0]];

  for (let i = 1; i < messages.length; i++) {
    const gap = messages[i].timestamp - messages[i - 1].timestamp;
    if (gap > gapSeconds) {
      rawThreads.push(current);
      current = [messages[i]];
    } else {
      current.push(messages[i]);
    }
  }
  rawThreads.push(current);

  const threads = [];
  for (const t of rawThreads) {
    if (t.length < MIN_THREAD_MESSAGES && threads.length > 0) {
      threads[threads.length - 1].push(...t);
    } else {
      threads.push([...t]);
    }
  }

  if (threads.length >= 2 && threads[0].length < MIN_THREAD_MESSAGES) {
    threads[1].unshift(...threads[0]);
    threads.shift();
  }

  return threads.filter(t => t.length >= MIN_THREAD_MESSAGES);
}

export { THREAD_GAP_SECONDS, MIN_THREAD_MESSAGES };
