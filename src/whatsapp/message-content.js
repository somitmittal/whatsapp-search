/**
 * Classify Baileys message content types and label the ones we keep but cannot render.
 *
 * Baileys surfaces WhatsApp's internal control frames through the same `messages.upsert` /
 * `messaging-history.set` events as real chat content. They carry no readable body, so
 * storing them produced junk rows such as `[protocol]` in the timeline and search index.
 */

/**
 * Frames that exist purely to drive the protocol (key exchange, revokes, disappearing-message
 * settings, encrypted side-channel payloads). None of them have a user-visible body, and the
 * ones that do carry meaning — reactions, poll votes — are ingested through their own pipelines.
 */
export const CONTROL_ONLY_CONTENT_TYPES = new Set([
  'protocolMessage',
  'senderKeyDistributionMessage',
  'fastRatchetKeySenderKeyDistributionMessage',
  'messageContextInfo',
  'reactionMessage',
  'encReactionMessage',
  'encCommentMessage',
  'encEventResponseMessage',
  'pollUpdateMessage',
  'keepInChatMessage',
  'pinInChatMessage',
  'stickerSyncRmrMessage',
  'placeholderMessage',
  'secretEncryptedMessage',
  'associatedChildMessage',
  'botInvokeMessage',
]);

/**
 * Content we keep because the event itself is meaningful to the reader, even though there is
 * no text to extract. Anything not listed falls back to a cleaned-up form of the proto key.
 */
const READABLE_LABELS = new Map([
  ['callLogMesssage', 'Call'],
  ['scheduledCallCreationMessage', 'Scheduled call'],
  ['scheduledCallEditMessage', 'Scheduled call updated'],
  ['groupInviteMessage', 'Group invite'],
  ['newsletterAdminInviteMessage', 'Channel admin invite'],
  ['orderMessage', 'Order'],
  ['productMessage', 'Product'],
  ['invoiceMessage', 'Invoice'],
  ['paymentInviteMessage', 'Payment request'],
  ['sendPaymentMessage', 'Payment'],
  ['requestPaymentMessage', 'Payment request'],
  ['requestPhoneNumberMessage', 'Phone number request'],
  ['eventMessage', 'Event'],
  ['albumMessage', 'Album'],
  ['stickerPackMessage', 'Sticker pack'],
  ['pollResultSnapshotMessage', 'Poll results'],
]);

export function isControlOnlyContentType(contentType) {
  return CONTROL_ONLY_CONTENT_TYPES.has(String(contentType || ''));
}

/**
 * Human-readable stand-in for content with no extractable text, e.g. `[Call]`.
 * The proto key `callLogMesssage` is misspelled upstream, hence the tolerant suffix strip.
 */
export function placeholderForContentType(contentType) {
  const ct = String(contentType || '');
  if (!ct) return '[Message]';
  const known = READABLE_LABELS.get(ct);
  if (known) return `[${known}]`;
  const words = ct.replace(/Mess+age$/i, '').replace(/([A-Z])/g, ' $1').trim();
  if (!words) return '[Message]';
  return `[${words.charAt(0).toUpperCase()}${words.slice(1)}]`;
}

/**
 * Placeholder strings that earlier builds wrote for frames we now drop. Used by the one-shot
 * DB cleanup so previously-synced archives lose their `[protocol]` rows too. Reproduces the
 * old formatting rather than restating it, so the two can never drift apart.
 */
export function legacyControlFramePlaceholders() {
  return [...CONTROL_ONLY_CONTENT_TYPES].map(
    (ct) => `[${ct.replace(/Message$/, '').replace(/([A-Z])/g, ' $1').trim()}]`,
  );
}
