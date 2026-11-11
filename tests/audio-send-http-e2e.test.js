/**
 * Live Express WebServer HTTP end-to-end test for:
 *  1. POST /api/wa/send-file (voice note ptt=1 from Chromium Opus-in-MP4)
 *  2. POST /api/wa/send-file (audio file upload ptt=0, including WebM/Opus-in-MP4)
 *  3. POST /api/wa/forward (forwarding stored audio)
 *  4. GET /api/message-media (inline & ?download=1 Content-Type, Content-Disposition filename,
 *     and real transcoded/playable bytes verified by ffprobe + music-metadata)
 */
import { describe, expect, test, beforeAll, afterAll } from '@jest/globals';
import { execFile } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { parseBuffer } from 'music-metadata';
import config from '../src/config.js';
import Database from '../src/storage/database.js';
import { LEGACY_TENANT_ID } from '../src/storage/tenant-constants.js';
import { runWithTenant } from '../src/storage/tenant-context.js';
import WaClient from '../src/whatsapp/wa-client.js';
import WebServer from '../src/web/server.js';
import { probeMediaStreams } from '../src/web/audio-transcode.js';

const execFileAsync = promisify(execFile);

function findFfmpeg() {
  for (const c of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
    if (existsSync(c)) return c;
  }
  return null;
}

describe('HTTP E2E audio send, forward, and /api/message-media playback', () => {
  const ffmpeg = findFfmpeg();
  const prev = {
    dataDir: config.dataDir,
    mediaDir: config.mediaDir,
    dbPath: config.dbPath,
    controlPlaneDbPath: config.controlPlaneDbPath,
    serverSecret: config.serverSecret,
    jwtSecret: config.jwtSecret,
    defaultTenantId: config.defaultTenantId,
    isDesktopApp: config.isDesktopApp,
    sessionEnv: process.env.SESSION_SECRET,
    jwtEnv: process.env.JWT_SECRET,
  };

  let dir;
  let db;
  let webServer;
  let client;
  let baseUrl;
  let sentPayloads = [];
  let opusInMp4Buf;
  let webmAudioBuf;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wa-http-e2e-'));
    config.dataDir = dir;
    config.mediaDir = join(dir, 'media');
    mkdirSync(config.mediaDir, { recursive: true });
    config.dbPath = join(dir, 'test.db');
    config.controlPlaneDbPath = join(dir, 'cp.db');
    config.serverSecret = '';
    config.jwtSecret = '';
    config.defaultTenantId = LEGACY_TENANT_ID;
    config.isDesktopApp = false;
    delete process.env.SESSION_SECRET;
    delete process.env.JWT_SECRET;

    if (ffmpeg) {
      const gen = async (args, name) => {
        const out = join(dir, name);
        await execFileAsync(ffmpeg, ['-y', ...args, out]);
        return readFileSync(out);
      };
      opusInMp4Buf = await gen([
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.0',
        '-c:a', 'libopus', '-b:a', '64k', '-f', 'mp4',
      ], 'chrome-voice.mp4');
      webmAudioBuf = await gen([
        '-f', 'lavfi', '-i', 'sine=frequency=587:duration=2.0',
        '-c:a', 'libopus', '-b:a', '64k', '-f', 'webm',
      ], 'upload-audio.webm');
    }

    db = new Database();
    webServer = new WebServer({ db });
    await new Promise((resolve) => {
      webServer._server.listen(0, '127.0.0.1', () => {
        const { port } = webServer._server.address();
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    let seq = 1;
    const onMessages = (rows) => runWithTenant(LEGACY_TENANT_ID, () => db.insertMessageBatch(rows));
    const onMediaPath = (mid, path) => runWithTenant(LEGACY_TENANT_ID, () => db.updateMessageMediaPath(mid, path));

    client = new WaClient({
      authDir: join(dir, 'auth'),
      configFile: join(dir, 'wa-config.json'),
      onMessages,
      onMediaPath,
      onMediaNeedsDownload: (mid) => runWithTenant(LEGACY_TENANT_ID, () => db.mediaNeedsDownload(mid)),
    });
    client._ownerJid = '12345@s.whatsapp.net';
    client._sock = {
      sendMessage: async (jid, content) => {
        const id = `3EB0HTTP${seq++}`;
        sentPayloads.push({ jid, content });
        const echo = {
          key: { remoteJid: jid, id, fromMe: true },
          messageTimestamp: Math.floor(Date.now() / 1000),
          status: 1,
          message: {
            audioMessage: {
              mimetype: content.mimetype,
              ptt: Boolean(content.ptt),
              seconds: content.seconds,
              waveform: content.waveform,
              caption: content.caption,
            },
          },
        };
        // Simulate Baileys upsert race right as sendMessage resolves.
        const row = client._msgToRow(echo);
        if (row) onMessages([row]);
        return echo;
      },
    };

    const st = webServer._getTenantState(LEGACY_TENANT_ID);
    st.waClient = client;
    st.waState = 'READY';
    st.extensionConnected = true;
  }, 30000);

  afterAll(async () => {
    try { await client?.destroy(); } catch {}
    try { webServer?.stop(); } catch {}
    try { db?.close(); } catch {}

    config.dataDir = prev.dataDir;
    config.mediaDir = prev.mediaDir;
    config.dbPath = prev.dbPath;
    config.controlPlaneDbPath = prev.controlPlaneDbPath;
    config.serverSecret = prev.serverSecret;
    config.jwtSecret = prev.jwtSecret;
    config.defaultTenantId = prev.defaultTenantId;
    config.isDesktopApp = prev.isDesktopApp;
    if (prev.sessionEnv == null) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prev.sessionEnv;
    if (prev.jwtEnv == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prev.jwtEnv;

    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('POST /api/wa/send-file (ptt=1) sends mobile Ogg Opus & GET /api/message-media serves playable .m4a', async () => {
    if (!ffmpeg) return;
    const chatJid = '919876543210@s.whatsapp.net';
    const form = new FormData();
    form.append('file', new Blob([opusInMp4Buf], { type: 'audio/mp4' }), 'voice-note-1.mp4');
    form.append('chatJid', chatJid);
    form.append('ptt', '1');

    const res = await fetch(`${baseUrl}/api/wa/send-file`, { method: 'POST', body: form });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.messageId).toBeTruthy();

    const sent = sentPayloads[sentPayloads.length - 1].content;
    expect(sent.mimetype).toBe('audio/ogg; codecs=opus');
    expect(sent.ptt).toBe(true);
    expect(sent.seconds).toBeGreaterThanOrEqual(2);
    expect(sent.waveform).toBeInstanceOf(Uint8Array);
    expect(sent.waveform.length).toBe(64);

    // Inline playback in Searchable browser transcodes Ogg -> fast-start M4A with matching filename.
    const mediaInline = await fetch(`${baseUrl}/api/message-media?messageId=${encodeURIComponent(body.messageId)}`);
    expect(mediaInline.status).toBe(200);
    expect(mediaInline.headers.get('content-type')).toContain('audio/mp4');
    const dispInline = mediaInline.headers.get('content-disposition') || '';
    expect(dispInline).toMatch(/^inline;\s*filename="[^"]+\.m4a"$/i);
    const inlineBytes = Buffer.from(await mediaInline.arrayBuffer());
    const meta = await parseBuffer(inlineBytes, { mimeType: 'audio/mp4' });
    expect(meta.format.duration).toBeGreaterThan(1.5);

    // Download endpoint also never leaves a .mp4 audio extension.
    const mediaDl = await fetch(`${baseUrl}/api/message-media?messageId=${encodeURIComponent(body.messageId)}&download=1`);
    expect(mediaDl.status).toBe(200);
    expect(mediaDl.headers.get('content-disposition')).toMatch(/^attachment;\s*filename="[^"]+\.m4a"$/i);
  });

  test('POST /api/wa/send-file (ptt=0) converts browser WebM audio to universal MP3 & serves .mp3', async () => {
    if (!ffmpeg) return;
    const chatJid = '919876543210@s.whatsapp.net';
    const form = new FormData();
    form.append('file', new Blob([webmAudioBuf], { type: 'video/webm' }), 'clip.webm');
    form.append('chatJid', chatJid);
    form.append('caption', 'song.mp4');

    const res = await fetch(`${baseUrl}/api/wa/send-file`, { method: 'POST', body: form });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const sent = sentPayloads[sentPayloads.length - 1].content;
    expect(sent.mimetype).toBe('audio/mpeg');
    expect(sent.ptt).toBeUndefined();
    expect(sent.seconds).toBeGreaterThanOrEqual(2);

    const mediaRes = await fetch(`${baseUrl}/api/message-media?messageId=${encodeURIComponent(body.messageId)}&download=1`);
    expect(mediaRes.status).toBe(200);
    expect(mediaRes.headers.get('content-type')).toContain('audio/mpeg');
    expect(mediaRes.headers.get('content-disposition')).toMatch(/^attachment;\s*filename="[^"]+\.mp3"$/i);
    const bytes = Buffer.from(await mediaRes.arrayBuffer());
    const probed = await probeMediaStreams(bytes, { fileName: 'dl.mp3' });
    expect(probed.formatName).toContain('mp3');
    expect(probed.audioCodec).toBe('mp3');
  });

  test('POST /api/wa/forward sends valid phone-playable audio & persists locally', async () => {
    if (!ffmpeg) return;
    const srcChat = '919876543210@s.whatsapp.net';
    const targetChat = '919999999999@s.whatsapp.net';
    const legacyPath = join(dir, 'media', 'legacy.mp4');
    writeFileSync(legacyPath, opusInMp4Buf);

    runWithTenant(LEGACY_TENANT_ID, () => {
      db.insertMessageBatch([{
        messageId: 'ORIG_FWD_AUDIO_1',
        chatJid: srcChat,
        chatName: 'Tester',
        sender: 'You',
        senderJid: null,
        text: null,
        mediaType: 'audio',
        mediaPath: legacyPath,
        mediaCaption: null,
        timestamp: Math.floor(Date.now() / 1000) - 60,
        status: 'sent',
      }]);
    });

    const fwdRes = await fetch(`${baseUrl}/api/wa/forward`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatJid: srcChat,
        messageId: 'ORIG_FWD_AUDIO_1',
        targetJids: [targetChat],
      }),
    });
    expect(fwdRes.status).toBe(200);
    const fwdBody = await fwdRes.json();
    expect(fwdBody.ok).toBe(true);
    expect(fwdBody.forwarded).toBe(1);
    const fwdId = fwdBody.results[0].messageId;
    expect(fwdId).toBeTruthy();

    const sent = sentPayloads[sentPayloads.length - 1].content;
    expect(sent.mimetype).toBe('audio/mpeg');
    expect(sent.seconds).toBeGreaterThanOrEqual(2);
    expect(sent.contextInfo).toEqual({ isForwarded: true, forwardingScore: 1 });

    const mediaRes = await fetch(`${baseUrl}/api/message-media?messageId=${encodeURIComponent(fwdId)}`);
    expect(mediaRes.status).toBe(200);
    expect(mediaRes.headers.get('content-type')).toContain('audio/mpeg');
    expect(mediaRes.headers.get('content-disposition')).toMatch(/^inline;\s*filename="[^"]+\.mp3"$/i);
  });
});
