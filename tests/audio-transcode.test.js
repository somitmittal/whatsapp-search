/** Voice-note & outbound audio normalization guarantees. */
import { describe, expect, test, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals';
import { execFile } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import * as musicMetadata from 'music-metadata';
import {
  needsPlayableAudioCopy,
  playableAudioFor,
  prepareOutboundAudioForWhatsApp,
  probeMediaStreams,
} from '../src/web/audio-transcode.js';

const execFileAsync = promisify(execFile);

function findFfmpeg() {
  for (const c of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
    if (existsSync(c)) return c;
  }
  return null;
}

describe('audio-transcode', () => {
  const originalEnv = process.env.FFMPEG_PATH;
  beforeEach(() => {
    process.env.FFMPEG_PATH = '/bin/false'; // 1-exit binary → transcode always fails
  });
  afterEach(() => {
    process.env.FFMPEG_PATH = originalEnv;
  });

  test('voice-note containers all request a playable copy', () => {
    for (const ext of ['ogg', 'oga', 'opus', 'mp4', 'm4a', 'webm']) {
      expect(needsPlayableAudioCopy(`note.${ext}`)).toBe(true);
    }
  });

  test('plain-playable formats pass through untouched', () => {
    for (const name of ['clip.mp3', 'tone.wav', 'audio.aac', 'song.flac', 'doc.pdf', 'clip.mov']) {
      expect(needsPlayableAudioCopy(name)).toBe(false);
    }
  });

  test('case-insensitive on extension', () => {
    expect(needsPlayableAudioCopy('VOICE.MP4')).toBe(true);
  });

  test('playableAudioFor: passthrough for extension-safe audio', async () => {
    await expect(playableAudioFor('/x/clip.mp3')).resolves.toEqual({
      path: '/x/clip.mp3',
      contentType: null,
    });
  });

  test('playableAudioFor: fallback to original when transcode fails', async () => {
    // ffmpeg (/bin/false) fails to write the .play.m4a cache → serve the original.
    await expect(playableAudioFor('/x/3EB0.mp4')).resolves.toEqual({
      path: '/x/3EB0.mp4',
      contentType: null,
    });
  });

  test('prepareOutboundAudioForWhatsApp: graceful fallback when ffmpeg/ffprobe unavailable', async () => {
    const raw = Buffer.from('fake-audio-bytes');
    const res = await prepareOutboundAudioForWhatsApp(raw, {
      mimeType: 'audio/x-m4a',
      fileName: 'memo.m4a',
      ptt: false,
    });
    expect(res.buffer).toBe(raw);
    expect(res.mimeType).toBe('audio/mp4');
    expect(res.ext).toBe('m4a');
    expect(res.transcoded).toBe(false);
  });
});

describe('outbound audio normalization & playable copy with real ffmpeg', () => {
  const ffmpeg = findFfmpeg();
  const prevFfmpegEnv = process.env.FFMPEG_PATH;
  const prevFfprobeEnv = process.env.FFPROBE_PATH;
  let dir;
  let opusInMp4Buf;
  let webmOpusBuf;
  let wavBuf;
  let monoOggBuf;
  let mp3Buf;
  let aacM4aBuf;
  let silentVideoBuf;
  let realVideoWithAudioBuf;

  beforeAll(async () => {
    delete process.env.FFMPEG_PATH;
    delete process.env.FFPROBE_PATH;
    if (!ffmpeg) return;
    dir = mkdtempSync(join(tmpdir(), 'audio-transcode-test-'));

    const gen = async (args, outName) => {
      const p = join(dir, outName);
      await execFileAsync(ffmpeg, ['-y', ...args, p]);
      return readFileSync(p);
    };

    // Exact macOS Chrome MediaRecorder('audio/mp4') failure mode: Opus inside MP4 container!
    opusInMp4Buf = await gen([
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.4',
      '-c:a', 'libopus', '-b:a', '64k', '-f', 'mp4',
    ], 'chrome-opus.mp4');

    webmOpusBuf = await gen([
      '-f', 'lavfi', '-i', 'sine=frequency=523:duration=2.1',
      '-c:a', 'libopus', '-b:a', '64k', '-f', 'webm',
    ], 'chrome-opus.webm');

    wavBuf = await gen([
      '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2.0',
      '-ac', '2', '-c:a', 'pcm_s16le', '-f', 'wav',
    ], 'stereo.wav');

    monoOggBuf = await gen([
      '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2.3',
      '-c:a', 'libopus', '-b:a', '48k', '-ar', '48000', '-ac', '1', '-f', 'ogg',
    ], 'native.ogg');

    mp3Buf = await gen([
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.2',
      '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3',
    ], 'song.mp3');

    // AAC-in-MP4 without faststart to verify remux + faststart M4A normalization
    aacM4aBuf = await gen([
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.2',
      '-c:a', 'aac', '-b:a', '128k', '-f', 'mp4',
    ], 'voice-memo.m4a');

    silentVideoBuf = await gen([
      '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=1.0',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'mp4',
    ], 'video-only.mp4');

    realVideoWithAudioBuf = await gen([
      '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=1.0',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.0',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mp4',
    ], 'av.mp4');
  }, 30000);

  afterAll(() => {
    if (prevFfmpegEnv !== undefined) process.env.FFMPEG_PATH = prevFfmpegEnv;
    else delete process.env.FFMPEG_PATH;
    if (prevFfprobeEnv !== undefined) process.env.FFPROBE_PATH = prevFfprobeEnv;
    else delete process.env.FFPROBE_PATH;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('ptt:true transcodes Opus-in-MP4 into phone-playable mono Ogg Opus with Baileys duration & waveform', async () => {
    if (!ffmpeg) return;
    const res = await prepareOutboundAudioForWhatsApp(opusInMp4Buf, {
      mimeType: 'audio/mp4',
      fileName: 'voice-note.m4a',
      ptt: true,
    });
    expect(res.transcoded).toBe(true);
    expect(res.mimeType).toBe('audio/ogg; codecs=opus');
    expect(res.ext).toBe('ogg');
    expect(res.durationSeconds).toBeGreaterThan(2.0);
    expect(res.waveform).toBeInstanceOf(Uint8Array);
    expect(res.waveform.length).toBe(64);
    expect(Math.max(...res.waveform)).toBeGreaterThan(0);

    // Baileys computes AudioMessage.seconds via music-metadata; verify it parses cleanly!
    const meta = await musicMetadata.parseBuffer(res.buffer, undefined, { duration: true });
    expect(meta.format.container).toBe('Ogg');
    expect(meta.format.codec).toBe('Opus');
    expect(meta.format.duration).toBeGreaterThan(2.0);
  });

  test('ptt:true transcodes WebM Opus into mono Ogg Opus with duration & waveform', async () => {
    if (!ffmpeg) return;
    const res = await prepareOutboundAudioForWhatsApp(webmOpusBuf, {
      mimeType: 'audio/webm;codecs=opus',
      fileName: 'voice-note.webm',
      ptt: true,
    });
    expect(res.transcoded).toBe(true);
    expect(res.mimeType).toBe('audio/ogg; codecs=opus');
    expect(res.ext).toBe('ogg');
    expect(res.waveform?.length).toBe(64);

    const probe = await probeMediaStreams(res.buffer, { fileName: 'out.ogg' });
    expect(probe.formatName).toContain('ogg');
    expect(probe.audioCodec).toBe('opus');
    expect(probe.channels).toBe(1);
    expect(probe.durationSeconds).toBeGreaterThan(1.8);
  });

  test('ptt:true passes mono Ogg Opus through without re-encoding while generating waveform', async () => {
    if (!ffmpeg) return;
    const res = await prepareOutboundAudioForWhatsApp(monoOggBuf, {
      mimeType: 'audio/ogg;codecs=opus',
      fileName: 'voice.ogg',
      ptt: true,
    });
    expect(res.transcoded).toBe(false);
    expect(res.buffer).toBe(monoOggBuf);
    expect(res.mimeType).toBe('audio/ogg; codecs=opus');
    expect(res.ext).toBe('ogg');
    expect(res.waveform?.length).toBe(64);
    expect(res.durationSeconds).toBeGreaterThan(2.0);
  });

  test('ptt:false converts Opus-in-MP4, WebM, WAV, and Ogg into universal phone-playable MP3', async () => {
    if (!ffmpeg) return;
    for (const sample of [
      { buf: opusInMp4Buf, mimeType: 'audio/mp4', fileName: 'rec.m4a' },
      { buf: webmOpusBuf, mimeType: 'audio/webm', fileName: 'rec.webm' },
      { buf: wavBuf, mimeType: 'audio/wav', fileName: 'stereo.wav' },
      { buf: monoOggBuf, mimeType: 'audio/ogg; codecs=opus', fileName: 'note.ogg' },
    ]) {
      const res = await prepareOutboundAudioForWhatsApp(sample.buf, {
        mimeType: sample.mimeType,
        fileName: sample.fileName,
        ptt: false,
      });
      expect(res.transcoded).toBe(true);
      expect(res.mimeType).toBe('audio/mpeg');
      expect(res.ext).toBe('mp3');
      expect(res.waveform).toBeUndefined();
      expect(res.durationSeconds).toBeGreaterThan(1.8);

      const meta = await musicMetadata.parseBuffer(res.buffer, undefined, { duration: true });
      expect(meta.format.container).toBe('MPEG');
      expect(meta.format.duration).toBeGreaterThan(1.8);
    }
  });

  test('ptt:false passes genuine MP3 through lossless & untouched', async () => {
    if (!ffmpeg) return;
    const res = await prepareOutboundAudioForWhatsApp(mp3Buf, {
      mimeType: 'audio/mp3',
      fileName: 'song.mp3',
      ptt: false,
    });
    expect(res.transcoded).toBe(false);
    expect(res.buffer).toBe(mp3Buf);
    expect(res.mimeType).toBe('audio/mpeg');
    expect(res.ext).toBe('mp3');
    expect(res.durationSeconds).toBeGreaterThan(2.0);
  });

  test('ptt:false remuxes AAC-in-MP4/M4A into fast-start M4A with valid metadata', async () => {
    if (!ffmpeg) return;
    const res = await prepareOutboundAudioForWhatsApp(aacM4aBuf, {
      mimeType: 'audio/x-m4a',
      fileName: 'voice-memo.m4a',
      ptt: false,
    });
    expect(res.transcoded).toBe(true);
    expect(res.mimeType).toBe('audio/mp4');
    expect(res.ext).toBe('m4a');
    expect(res.durationSeconds).toBeGreaterThan(2.0);

    const meta = await musicMetadata.parseBuffer(res.buffer, undefined, { duration: true });
    expect(meta.format.container).toContain('M4A');
    expect(meta.format.codec).toContain('AAC');
    expect(meta.format.duration).toBeGreaterThan(2.0);
  });

  test('probeMediaStreams distinguishes audio-only containers from genuine video', async () => {
    if (!ffmpeg) return;
    const audioOnly = await probeMediaStreams(opusInMp4Buf, { fileName: '3EB0.mp4' });
    expect(audioOnly.hasAudio).toBe(true);
    expect(audioOnly.hasVideo).toBe(false);

    const realVideo = await probeMediaStreams(realVideoWithAudioBuf, { fileName: 'av.mp4' });
    expect(realVideo.hasAudio).toBe(true);
    expect(realVideo.hasVideo).toBe(true);
  });

  test('prepareOutboundAudioForWhatsApp rejects a video-only file with no audio stream', async () => {
    if (!ffmpeg) return;
    await expect(
      prepareOutboundAudioForWhatsApp(silentVideoBuf, { mimeType: 'audio/mp4', ptt: false }),
    ).rejects.toThrow(/no playable audio stream/i);
  });

  test('playableAudioFor produces a fast-start AAC .play.m4a copy for browser/mobile playback', async () => {
    if (!ffmpeg) return;
    const srcPath = join(dir, 'chrome-opus.mp4');
    const served = await playableAudioFor(srcPath);
    expect(served.contentType).toBe('audio/mp4');
    expect(served.path).toBe(join(dir, 'chrome-opus.play.m4a'));

    const meta = await musicMetadata.parseFile(served.path, { duration: true });
    expect(meta.format.codec).toContain('AAC');
    expect(meta.format.duration).toBeGreaterThan(2.0);
  });
});
