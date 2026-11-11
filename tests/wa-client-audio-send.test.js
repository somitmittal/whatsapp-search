/**
 * End-to-end integration tests for outbound audio sending, forwarding,
 * local persistence, MIME/container normalization, and echo de-duplication.
 */
import { describe, expect, test, beforeAll, afterAll } from '@jest/globals';
import { execFile } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import config from '../src/config.js';
import Database from '../src/storage/database.js';
import WaClient from '../src/whatsapp/wa-client.js';
import { probeMediaStreams } from '../src/web/audio-transcode.js';

const execFileAsync = promisify(execFile);

function findFfmpeg() {
  for (const c of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
    if (existsSync(c)) return c;
  }
  return null;
}

describe('WaClient outbound audio send & forward', () => {
  const ffmpeg = findFfmpeg();
  const prevMediaDir = config.mediaDir;
  const prevDataDir = config.dataDir;
  const prevDbPath = config.dbPath;
  let dir;
  let mediaDir;
  let harnessSeq = 0;
  let opusInMp4Buf;
  let webmAudioOnlyBuf;
  let realVideoMp4Buf;
  let aacM4aBuf;
  let monoOggBuf;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wa-audio-send-'));
    mediaDir = join(dir, 'media');
    config.dataDir = dir;
    config.mediaDir = mediaDir;
    config.dbPath = join(dir, 'init.db');
    if (!ffmpeg) return;

    const gen = async (args, name) => {
      const out = join(dir, name);
      await execFileAsync(ffmpeg, ['-y', ...args, out]);
      return readFileSync(out);
    };

    opusInMp4Buf = await gen([
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.1',
      '-c:a', 'libopus', '-b:a', '64k', '-f', 'mp4',
    ], 'chrome-voice.mp4');

    webmAudioOnlyBuf = await gen([
      '-f', 'lavfi', '-i', 'sine=frequency=523:duration=2.0',
      '-c:a', 'libopus', '-b:a', '64k', '-f', 'webm',
    ], 'browser-audio-only.webm');

    realVideoMp4Buf = await gen([
      '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=1.0',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.0',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mp4',
    ], 'clip.mp4');

    aacM4aBuf = await gen([
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.0',
      '-c:a', 'aac', '-b:a', '128k', '-f', 'mp4',
    ], 'memo.m4a');

    monoOggBuf = await gen([
      '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2.2',
      '-c:a', 'libopus', '-b:a', '48k', '-ar', '48000', '-ac', '1', '-f', 'ogg',
    ], 'inbound-vn.ogg');
  }, 30000);

  afterAll(() => {
    config.mediaDir = prevMediaDir;
    config.dataDir = prevDataDir;
    config.dbPath = prevDbPath;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeHarness() {
    config.dbPath = join(dir, `harness-${++harnessSeq}.db`);
    const db = new Database();
    const sentPayloads = [];
    const mediaPathEvents = [];
    let nextId = 1;
    let client;

    client = new WaClient({
      authDir: join(dir, 'auth'),
      configFile: join(dir, 'wa-config.json'),
      onMessages: (rows) => db.insertMessageBatch(rows),
      onMediaPath: (messageId, mediaPath) => {
        db.updateMessageMediaPath(messageId, mediaPath);
        mediaPathEvents.push({ messageId, mediaPath });
      },
      onMediaNeedsDownload: (messageId) => db.mediaNeedsDownload(messageId),
    });
    client._ownerJid = '12345@s.whatsapp.net';
    client._sock = {
      sendMessage: async (jid, content) => {
        const id = `3EB0TEST${nextId++}`;
        sentPayloads.push({ jid, content });
        const echo = {
          key: { remoteJid: jid, id, fromMe: true },
          messageTimestamp: Math.floor(Date.now() / 1000),
          status: 1,
          message: content.video
            ? { videoMessage: { mimetype: content.mimetype } }
            : content.document
              ? { documentMessage: { mimetype: content.mimetype, fileName: content.fileName } }
              : {
                  audioMessage: {
                    mimetype: content.mimetype,
                    ptt: Boolean(content.ptt),
                    seconds: content.seconds,
                    waveform: content.waveform,
                  },
                },
        };
        return echo;
      },
    };
    return { client, db, sentPayloads, mediaPathEvents };
  }

  test('sendFile (ptt:true) converts Chrome Opus-in-MP4 voice note to Ogg Opus with duration, waveform & .ogg DB persistence', async () => {
    if (!ffmpeg) return;
    const { client, db, sentPayloads } = makeHarness();
    try {
      const sent = await client.sendFile('919876543210@s.whatsapp.net', opusInMp4Buf, {
        fileName: 'voice-note-1.m4a',
        mimetype: 'audio/mp4',
        ptt: true,
      });

      expect(sentPayloads).toHaveLength(1);
      const payload = sentPayloads[0].content;
      expect(payload.mimetype).toBe('audio/ogg; codecs=opus');
      expect(payload.ptt).toBe(true);
      expect(payload.seconds).toBeGreaterThanOrEqual(2);
      expect(payload.waveform).toBeInstanceOf(Uint8Array);
      expect(payload.waveform.length).toBe(64);

      const probed = await probeMediaStreams(payload.audio, { fileName: 'sent.ogg' });
      expect(probed.formatName).toContain('ogg');
      expect(probed.audioCodec).toBe('opus');
      expect(probed.channels).toBe(1);

      const rec = db.getMessageMediaRecord(sent.key.id);
      expect(rec.mediaType).toBe('audio');
      expect(rec.mediaPath).toMatch(/\.ogg$/);
      expect(existsSync(rec.mediaPath)).toBe(true);

      // Outbound self-echo must skip redundant CDN queue download when persisted locally.
      const rowFromEcho = client._msgToRow(sent);
      expect(rowFromEcho.mediaPath).toBe(rec.mediaPath);
      expect(rowFromEcho.mediaDownloadJson).toBeNull();
      client._queueMediaDownload(sent, rowFromEcho);
      expect(client.isMediaQueued(sent.key.id)).toBe(false);
    } finally {
      await client.destroy();
      db.close();
    }
  });

  test('sendFile (ptt:false) infers audio for .opus with application/octet-stream and audio-only video/webm', async () => {
    if (!ffmpeg) return;
    const { client, db, sentPayloads } = makeHarness();
    try {
      const sentOpus = await client.sendFile('919876543210@s.whatsapp.net', monoOggBuf, {
        fileName: 'clip.opus',
        mimetype: 'application/octet-stream',
        ptt: false,
      });
      expect(sentPayloads[0].content.mimetype).toBe('audio/mpeg');
      expect(sentPayloads[0].content.ptt).toBeUndefined();
      expect(sentPayloads[0].content.seconds).toBeGreaterThanOrEqual(2);
      expect(db.getMessageMediaRecord(sentOpus.key.id).mediaPath).toMatch(/\.mp3$/);

      const sentWebmAudio = await client.sendFile('919876543210@s.whatsapp.net', webmAudioOnlyBuf, {
        fileName: 'recording.webm',
        mimetype: 'video/webm',
        ptt: false,
      });
      expect(sentPayloads[1].content.audio).toBeInstanceOf(Buffer);
      expect(sentPayloads[1].content.video).toBeUndefined();
      expect(sentPayloads[1].content.mimetype).toBe('audio/mpeg');
      expect(db.getMessageMediaRecord(sentWebmAudio.key.id).mediaPath).toMatch(/\.mp3$/);
    } finally {
      await client.destroy();
      db.close();
    }
  });

  test('sendFile keeps genuine video/mp4 files as video and handles audio/x-m4a AAC attachments', async () => {
    if (!ffmpeg) return;
    const { client, db, sentPayloads } = makeHarness();
    try {
      const sentVid = await client.sendFile('919876543210@s.whatsapp.net', realVideoMp4Buf, {
        fileName: 'clip.mp4',
        mimetype: 'video/mp4',
      });
      expect(sentPayloads[0].content.video).toBe(realVideoMp4Buf);
      expect(db.getMessageMediaRecord(sentVid.key.id).mediaType).toBe('video');

      const sentM4a = await client.sendFile('919876543210@s.whatsapp.net', aacM4aBuf, {
        fileName: 'memo.m4a',
        mimetype: 'audio/x-m4a',
      });
      expect(sentPayloads[1].content.mimetype).toBe('audio/mp4');
      expect(sentPayloads[1].content.seconds).toBeGreaterThanOrEqual(2);
      expect(db.getMessageMediaRecord(sentM4a.key.id).mediaPath).toMatch(/\.m4a$/);
    } finally {
      await client.destroy();
      db.close();
    }
  });

  test('forwardMessage converts stored .mp4/.ogg audio to universal phone-playable audio instead of hardcoded ogg', async () => {
    if (!ffmpeg) return;
    const { client, db, sentPayloads } = makeHarness();
    try {
      const srcMp4Path = join(dir, 'legacy-voice.mp4');
      writeFileSync(srcMp4Path, opusInMp4Buf);
      const forwarded = await client.forwardMessage('919876543210@s.whatsapp.net', {
        messageId: 'ORIG1',
        chatJid: '12345@s.whatsapp.net',
        mediaType: 'audio',
        mediaPath: srcMp4Path,
        sender: 'You',
      });

      expect(sentPayloads).toHaveLength(1);
      const payload = sentPayloads[0].content;
      expect(payload.mimetype).toBe('audio/mpeg');
      expect(payload.ptt).toBeUndefined();
      expect(payload.seconds).toBeGreaterThanOrEqual(2);
      expect(payload.contextInfo).toEqual({ isForwarded: true, forwardingScore: 1 });

      const probed = await probeMediaStreams(payload.audio, { fileName: 'fwd.mp3' });
      expect(probed.formatName).toContain('mp3');
      expect(probed.audioCodec).toBe('mp3');

      const rec = db.getMessageMediaRecord(forwarded.key.id);
      expect(rec.mediaPath).toMatch(/\.mp3$/);
      expect(existsSync(rec.mediaPath)).toBe(true);
    } finally {
      await client.destroy();
      db.close();
    }
  });
});
