/**
 * Conversation-Aware Chunking & Turn Stitcher for WhatsApp
 *
 * Implements:
 * 1. Rapid-fire turn stitching (merges same-sender messages within 90s into single turns)
 * 2. Inactivity gap segmentation (15-30 min idle boundary seals a conversation session)
 * 3. Enriched session chunk formatting (Metadata headers: Chat, Time window, Participants)
 */

export const DEFAULT_SESSION_GAP_SECONDS = 30 * 60; // 30 minutes
export const DEFAULT_MAX_CHUNK_MESSAGES = 30;
export const STITCH_GAP_SECONDS = 90; // 90 seconds for consecutive messages from same sender

function formatClockTime(unixTs) {
  const d = new Date(unixTs * 1000);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatDate(unixTs) {
  const d = new Date(unixTs * 1000);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Pre-processes messages from a chat by stitching rapid-fire consecutive messages
 * from the same sender into a single cohesive turn.
 *
 * @param {Array<object>} messages Sorted chronologically
 * @param {number} maxGapSec Max seconds between same-sender messages to stitch
 */
export function stitchConsecutiveTurns(messages, maxGapSec = STITCH_GAP_SECONDS) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const turns = [];
  let currentTurn = null;

  for (const m of messages) {
    if (!m) continue;
    const sender = m.sender || 'Unknown';
    const ts = Number(m.timestamp) || 0;
    const body = String(m.text || m.mediaCaption || '').trim();
    const mediaTag = m.mediaType && m.mediaType !== 'text' ? `[${m.mediaType}]` : '';
    const handle = m.id ? `[m${m.id}]` : (m.messageId ? `[${m.messageId}]` : '');

    const messageText = [mediaTag, body, handle].filter(Boolean).join(' ').trim();
    if (!messageText) continue;

    const canStitch =
      currentTurn &&
      currentTurn.sender === sender &&
      ts - currentTurn.lastTs <= maxGapSec &&
      currentTurn.lines.length < 8;

    if (canStitch) {
      currentTurn.lines.push(messageText);
      currentTurn.messageIds.push(m.id || m.messageId);
      currentTurn.lastTs = ts;
    } else {
      if (currentTurn) {
        turns.push({
          sender: currentTurn.sender,
          startTs: currentTurn.startTs,
          endTs: currentTurn.lastTs,
          text: currentTurn.lines.join('\n'),
          messageIds: currentTurn.messageIds,
        });
      }
      currentTurn = {
        sender,
        startTs: ts,
        lastTs: ts,
        lines: [messageText],
        messageIds: [m.id || m.messageId].filter(Boolean),
      };
    }
  }

  if (currentTurn) {
    turns.push({
      sender: currentTurn.sender,
      startTs: currentTurn.startTs,
      endTs: currentTurn.lastTs,
      text: currentTurn.lines.join('\n'),
      messageIds: currentTurn.messageIds,
    });
  }

  return turns;
}

/**
 * Splits chronologically-sorted messages of a chat into distinct conversation sessions
 * based on inactivity gaps (default 30 min) or a maximum message limit per chunk.
 *
 * @param {Array<object>} messages
 * @param {object} opts
 */
export function segmentMessagesIntoSessions(
  messages,
  {
    gapSeconds = DEFAULT_SESSION_GAP_SECONDS,
    maxMessages = DEFAULT_MAX_CHUNK_MESSAGES,
  } = {}
) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const sorted = [...messages].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  const sessions = [];
  let current = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const gap = (curr.timestamp || 0) - (prev.timestamp || 0);

    if (gap > gapSeconds || current.length >= maxMessages) {
      sessions.push(current);
      current = [curr];
    } else {
      current.push(curr);
    }
  }
  if (current.length) {
    sessions.push(current);
  }

  return sessions;
}

/**
 * Builds an enriched, self-contained text chunk for one conversation session.
 *
 * @param {Array<object>} sessionMessages Raw messages in this session
 * @param {object} meta
 */
export function buildConversationChunk(sessionMessages, { chatJid, chatName }) {
  if (!sessionMessages || sessionMessages.length === 0) return null;
  const startTs = sessionMessages[0].timestamp;
  const endTs = sessionMessages[sessionMessages.length - 1].timestamp;

  const participants = [
    ...new Set(
      sessionMessages
        .map((m) => m.sender)
        .filter((s) => s && s !== 'Unknown')
    ),
  ];

  const turns = stitchConsecutiveTurns(sessionMessages);
  const turnLines = turns.map((t) => {
    const clock = formatClockTime(t.startTs);
    return `[${clock}] ${t.sender}: ${t.text}`;
  });

  const startDateStr = formatDate(startTs);
  const startTimeStr = formatClockTime(startTs);
  const endTimeStr = formatClockTime(endTs);
  const timeWindow = startTimeStr === endTimeStr ? startTimeStr : `${startTimeStr} – ${endTimeStr}`;

  const header = `=== Session: ${chatName || chatJid} | ${startDateStr} ${timeWindow} | Participants: ${participants.join(', ') || 'Unknown'} ===`;
  const sessionText = `${header}\n${turnLines.join('\n')}`;

  const allMessageIds = [
    ...new Set(
      sessionMessages.map((m) => m.id || m.messageId).filter((x) => x != null)
    ),
  ];

  const chunkId = `chunk_${chatJid}_${startTs}_${endTs}`;

  return {
    id: chunkId,
    chatJid,
    chatName: chatName || chatJid,
    startTs,
    endTs,
    messageCount: sessionMessages.length,
    messageIds: allMessageIds,
    participants,
    sessionText,
  };
}

/**
 * Indexes conversation sessions for a given chat into the database's conversation_chunks table.
 * Deterministic, non-blocking, zero LLM calls (<0.1ms per session).
 *
 * @param {object} db Database instance
 * @param {string} chatJid
 * @param {object} [opts]
 */
export function indexChatConversationChunks(db, chatJid, { limit = 300, chatName = null } = {}) {
  if (!db || !chatJid) return 0;
  const linkedJids = typeof db.getLinkedJids === 'function' ? db.getLinkedJids(chatJid) : [chatJid];
  const messages = typeof db.getMessagesPaginatedForJids === 'function'
    ? db.getMessagesPaginatedForJids(linkedJids, limit, 0)
    : (typeof db.getMessagesPaginated === 'function' ? db.getMessagesPaginated(chatJid, limit, 0) : []);

  if (!messages.length) return 0;
  const sessions = segmentMessagesIntoSessions(messages);
  let created = 0;

  for (const sessionMsgs of sessions) {
    if (!sessionMsgs.length) continue;
    const resolvedName = chatName || sessionMsgs.find((m) => m.chatName)?.chatName || null;
    const chunk = buildConversationChunk(sessionMsgs, { chatJid, chatName: resolvedName });
    if (chunk && typeof db.upsertConversationChunk === 'function') {
      db.upsertConversationChunk(chunk);
      created += 1;
    }
  }

  return created;
}
