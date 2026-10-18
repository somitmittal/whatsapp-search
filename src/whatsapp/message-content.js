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

/** True for synthetic stand-ins like `[Template]` / `[Call]` (not real message bodies). */
export function isContentPlaceholder(text) {
  const t = String(text || '').trim();
  return /^\[[^[\]]{1,80}\]$/.test(t);
}

function joinTemplateParts(...parts) {
  return parts.map((p) => String(p || '').trim()).filter(Boolean).join('\n').trim();
}

function textFromInteractiveMessage(im) {
  if (!im || typeof im !== 'object') return '';
  return joinTemplateParts(
    im.header?.title,
    im.header?.hydratedTitleText,
    im.body?.text,
    im.footer?.text,
  );
}

function textFromHydratedFourRow(h) {
  if (!h || typeof h !== 'object') return '';
  return joinTemplateParts(
    h.hydratedTitleText,
    h.hydratedContentText,
    h.contentText,
    h.hydratedFooterText,
  );
}

/**
 * Pull user-visible copy from template / interactive / HSM shapes Baileys does not flatten.
 * Call on the inner message (after `extractMessageContent` when available).
 */
export function extractRenderableTextFromInner(m) {
  if (!m || typeof m !== 'object') return '';

  const direct = (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    m.liveLocationMessage?.caption ||
    m.locationMessage?.name ||
    m.contactMessage?.displayName ||
    m.pollCreationMessage?.name ||
    m.buttonsMessage?.contentText ||
    m.listMessage?.description ||
    ''
  );
  if (String(direct || '').trim()) return String(direct).trim();

  const tm = m.templateMessage;
  if (tm) {
    const fromInteractive = textFromInteractiveMessage(tm.interactiveMessageTemplate);
    if (fromInteractive) return fromInteractive;
    const fromHydrated = textFromHydratedFourRow(tm.hydratedFourRowTemplate)
      || textFromHydratedFourRow(tm.hydratedTemplate)
      || textFromHydratedFourRow(tm.fourRowTemplate);
    if (fromHydrated) return fromHydrated;
  }

  const fromTopInteractive = textFromInteractiveMessage(m.interactiveMessage);
  if (fromTopInteractive) return fromTopInteractive;

  const hsm = m.highlyStructuredMessage;
  if (hsm) {
    const nested = hsm.hydratedHsm?.hydratedTemplate
      || hsm.hydratedHsm?.hydratedFourRowTemplate
      || hsm.hydratedHsm;
    const fromHsm = textFromHydratedFourRow(nested) || textFromInteractiveMessage(nested);
    if (fromHsm) return fromHsm;
    if (Array.isArray(hsm.params) && hsm.params.length) {
      return hsm.params.map((p) => String(p ?? '').trim()).filter(Boolean).join(' ').trim();
    }
  }

  const docFn = m.documentMessage?.fileName ? String(m.documentMessage.fileName).trim() : '';
  return docFn || '';
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
