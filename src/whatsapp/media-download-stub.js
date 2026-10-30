/**
 * Persist enough of a Baileys media message to retry `downloadMediaMessage` after restart.
 * Full history event objects are too large / ephemeral to keep; only key + media node.
 */

const MEDIA_NODE_KEYS = [
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'stickerMessage',
  'documentMessage',
];

function bufferToJson(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { __buf: Buffer.from(value).toString('base64') };
  }
  return value;
}

function jsonToBuffer(value) {
  if (value && typeof value === 'object' && typeof value.__buf === 'string') {
    return Buffer.from(value.__buf, 'base64');
  }
  return value;
}

function mapDeep(input, fn) {
  if (input == null || typeof input !== 'object') return fn(input);
  if (Array.isArray(input)) return input.map((v) => mapDeep(v, fn));
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) return fn(input);
  const out = {};
  for (const [k, v] of Object.entries(input)) out[k] = mapDeep(v, fn);
  return out;
}

/** @param {object} msg Baileys WAMessage */
export function buildMediaDownloadStub(msg) {
  const key = msg?.key;
  const message = msg?.message;
  if (!key?.remoteJid || !key?.id || !message || typeof message !== 'object') return null;
  let mediaNode = null;
  for (const k of MEDIA_NODE_KEYS) {
    if (message[k]) {
      mediaNode = { [k]: message[k] };
      break;
    }
  }
  // Ephemeral / view-once wrappers: dig one level.
  if (!mediaNode) {
    for (const wrap of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage']) {
      const inner = message[wrap]?.message;
      if (!inner) continue;
      for (const k of MEDIA_NODE_KEYS) {
        if (inner[k]) {
          mediaNode = { [k]: inner[k] };
          break;
        }
      }
      if (mediaNode) break;
    }
  }
  if (!mediaNode) return null;
  const stub = {
    key: {
      remoteJid: String(key.remoteJid),
      id: String(key.id),
      fromMe: Boolean(key.fromMe),
      ...(key.participant ? { participant: String(key.participant) } : {}),
    },
    message: mapDeep(mediaNode, bufferToJson),
  };
  try {
    return JSON.stringify(stub);
  } catch {
    return null;
  }
}

/** @returns {{ key: object, message: object } | null} */
export function parseMediaDownloadStub(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const stub = JSON.parse(raw, (_k, v) => jsonToBuffer(v));
    if (!stub?.key?.remoteJid || !stub?.key?.id || !stub?.message) return null;
    return {
      key: stub.key,
      message: mapDeep(stub.message, jsonToBuffer),
    };
  } catch {
    return null;
  }
}
