import Crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import {
  DEF_MEDIA_HOST,
  extractMessageContent,
  getContentType,
  getMediaKeys,
  getUrlFromDirectPath,
} from '@whiskeysockets/baileys';

const AES_CHUNK_SIZE = 16;
const DEFAULT_ORIGIN = 'https://web.whatsapp.com';
const REUPLOAD_REQUIRED_STATUS = [410, 404];

function toSmallestChunkSize(num) {
  return Math.floor(num / AES_CHUNK_SIZE) * AES_CHUNK_SIZE;
}

function extractHost(url) {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * Decrypts AES-256-CBC encrypted media streams downloaded from WhatsApp CDN with
 * robust stream error handling and lifecycle cleanup.
 *
 * Node.js's `Readable.pipe()` does not propagate errors from source to destination.
 * Baileys' native `downloadEncryptedContent` simply called `fetched.pipe(output)`
 * without attaching an 'error' listener to `fetched`. When undici terminates a socket
 * or connection drops, `fetched` emitted an unhandled 'error' event and crashed Node.
 * This implementation bridges errors and lifecycle explicitly so streams fail cleanly
 * into caller `pipeline()` / `try/catch` blocks.
 */
export async function downloadEncryptedContentSafe(
  downloadUrl,
  { cipherKey, iv },
  options = {},
) {
  const { startByte, endByte } = options;
  let bytesFetched = 0;
  let startChunk = 0;
  let firstBlockIsIV = false;

  if (startByte) {
    const chunk = toSmallestChunkSize(startByte || 0);
    if (chunk) {
      startChunk = chunk - AES_CHUNK_SIZE;
      bytesFetched = chunk;
      firstBlockIsIV = true;
    }
  }
  const endChunk = endByte ? toSmallestChunkSize(endByte || 0) + AES_CHUNK_SIZE : undefined;
  const headersInit = options?.headers;
  const headers = {
    ...(headersInit
      ? Array.isArray(headersInit)
        ? Object.fromEntries(headersInit)
        : headersInit
      : {}),
    Origin: DEFAULT_ORIGIN,
  };
  if (startChunk || endChunk) {
    headers.Range = `bytes=${startChunk}-`;
    if (endChunk) {
      headers.Range += endChunk;
    }
  }

  const response = await fetch(downloadUrl.toString(), {
    dispatcher: options?.dispatcher,
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    try { await response.body?.cancel(); } catch (_) {}
    const err = new Error(`Failed to fetch stream from ${downloadUrl} (HTTP ${response.status})`);
    err.statusCode = response.status;
    err.status = response.status;
    throw err;
  }

  const fetched = response.body instanceof Readable ? response.body : Readable.fromWeb(response.body);

  let remainingBytes = Buffer.from([]);
  let aes = null;
  const pushBytes = (bytes, push) => {
    if (startByte || endByte) {
      const start = bytesFetched >= startByte ? undefined : Math.max(startByte - bytesFetched, 0);
      const end = bytesFetched + bytes.length < endByte ? undefined : Math.max(endByte - bytesFetched, 0);
      push(bytes.slice(start, end));
      bytesFetched += bytes.length;
    } else {
      push(bytes);
    }
  };

  const output = new Transform({
    transform(chunk, _, callback) {
      let data = remainingBytes.length ? Buffer.concat([remainingBytes, chunk]) : chunk;
      const decryptLength = toSmallestChunkSize(data.length);
      remainingBytes = data.slice(decryptLength);
      data = data.slice(0, decryptLength);
      if (!aes) {
        let ivValue = iv;
        if (firstBlockIsIV) {
          ivValue = data.slice(0, AES_CHUNK_SIZE);
          data = data.slice(AES_CHUNK_SIZE);
        }
        aes = Crypto.createDecipheriv('aes-256-cbc', cipherKey, ivValue);
        if (endByte) {
          aes.setAutoPadding(false);
        }
      }
      try {
        pushBytes(aes.update(data), (b) => this.push(b));
        callback();
      } catch (error) {
        callback(error);
      }
    },
    final(callback) {
      try {
        if (aes) {
          pushBytes(aes.final(), (b) => this.push(b));
        }
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });

  // Critical: Bridge errors and stream closure between upstream fetched and output
  fetched.on('error', (err) => {
    if (!output.destroyed) {
      output.destroy(err);
    }
  });

  output.on('close', () => {
    if (!fetched.destroyed) {
      try { fetched.destroy(); } catch (_) {}
    }
  });

  return fetched.pipe(output, { end: true });
}

/**
 * Downloads WhatsApp media messages safely with reupload support and stream lifecycle management.
 */
export async function downloadMediaMessageSafe(
  message,
  type = 'stream',
  options = {},
  ctx = {},
) {
  const downloadMsg = async (targetMsg) => {
    const mContent = extractMessageContent(targetMsg?.message);
    if (!mContent) {
      const err = new Error('No message present');
      err.statusCode = 400;
      throw err;
    }
    const contentType = getContentType(mContent);
    let mediaType = contentType?.replace('Message', '');
    const media = mContent[contentType];
    if (!media || typeof media !== 'object' || (!('url' in media) && !('thumbnailDirectPath' in media))) {
      const err = new Error(`"${contentType}" message is not a media message`);
      err.statusCode = 400;
      throw err;
    }
    let download;
    if ('thumbnailDirectPath' in media && !('url' in media)) {
      download = {
        directPath: media.thumbnailDirectPath,
        mediaKey: media.mediaKey,
      };
      mediaType = 'thumbnail-link';
    } else {
      download = media;
    }

    const fallbackHost = options?.host ?? extractHost(download.url);
    const downloadUrl = download.directPath
      ? getUrlFromDirectPath(download.directPath, fallbackHost)
      : download.url;
    if (!downloadUrl) {
      const err = new Error('No valid media URL or directPath present in message');
      err.statusCode = 400;
      throw err;
    }

    const keys = await getMediaKeys(download.mediaKey, mediaType);
    const stream = await downloadEncryptedContentSafe(downloadUrl, keys, options);

    if (type === 'buffer') {
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    }
    return stream;
  };

  try {
    return await downloadMsg(message);
  } catch (error) {
    const status = error?.statusCode ?? error?.status;
    if (
      ctx &&
      typeof status === 'number' &&
      REUPLOAD_REQUIRED_STATUS.includes(status) &&
      typeof ctx.reuploadRequest === 'function'
    ) {
      ctx.logger?.info?.({ key: message?.key }, 'sending reupload media request...');
      const refreshed = await ctx.reuploadRequest(message);
      return await downloadMsg(refreshed || message);
    }
    throw error;
  }
}
