/**
 * WhatsApp voice notes and audio files come in browser/OS-hostile formats:
 *  - Ogg Opus (`.ogg`/`.oga`/`.opus`): Safari cannot decode Ogg at all; non-PTT
 *    iOS/Android players often reject raw Ogg/Opus attachments.
 *  - Opus in an MP4 container (`.mp4`/`.m4a` recorded by Chromium/Electron
 *    MediaRecorder when asking for `audio/mp4`): phones fail to open it cleanly
 *    and WhatsApp's `music-metadata` duration parser reports `0s`.
 *  - WebM Opus, WAV, FLAC, ALAC, AIFF, CAF, AMR: browsers/phones diverge wildly.
 *
 * Inbound serve (`playableAudioFor`):
 *   Transcodes Ogg/Opus/MP4/M4A/WebM voice notes to fast-start AAC/m4a on first
 *   serve and caches `.play.m4a` next to the original.
 *
 * Outbound send/forward (`prepareOutboundAudioForWhatsApp`):
 *   - `ptt: true` (voice notes) -> mono Ogg Opus 48kHz (`audio/ogg; codecs=opus`)
 *     with accurate duration (`seconds`) and 64-bar `waveform`.
 *   - `ptt: false` (audio attachments / forwards) -> keeps valid MP3 lossless,
 *     remuxes AAC-in-M4A/MP4 cleanly with `-movflags +faststart -f ipod`, and
 *     transcodes everything else (Opus-in-MP4, WebM, Ogg, WAV, FLAC, etc.) to
 *     universal MP3 (`audio/mpeg`) with AAC M4A fallback.
 */
import { execFile } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { promisify } from 'util';
import { audioFileExt, normalizeAudioMime } from '../whatsapp/voice-content.js';

const execFileAsync = promisify(execFile);

/** Suffix for the cached, browser-playable copy. */
const PLAY_SUFFIX = '.play.m4a';

/** On-disk extensions whose audio needs an AAC copy for universal playback. */
const NEEDS_PLAYABLE_COPY = new Set(['ogg', 'oga', 'opus', 'mp4', 'm4a', 'webm']);

function ffmpegBin() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  for (const candidate of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
    if (existsSync(candidate)) return candidate;
  }
  return 'ffmpeg';
}

function ffprobeBin() {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  if (process.env.FFMPEG_PATH) {
    const sibling = join(dirname(process.env.FFMPEG_PATH), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    if (existsSync(sibling)) return sibling;
    if (!/ffmpeg/i.test(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  }
  for (const candidate of ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe']) {
    if (existsSync(candidate)) return candidate;
  }
  return 'ffprobe';
}

export function needsPlayableAudioCopy(filePath) {
  const ext = (String(filePath).split('.').pop() || '').toLowerCase();
  return NEEDS_PLAYABLE_COPY.has(ext);
}

/**
 * Probe audio/video streams and duration from a file on disk using `ffprobe`.
 * Attached cover art streams (`disposition.attached_pic === 1`) are ignored when
 * determining `hasVideo`. Returns `null` if ffprobe is unavailable or fails.
 *
 * @param {string} absPath
 * @returns {Promise<{ formatName: string, durationSeconds: number|undefined, hasAudio: boolean, hasVideo: boolean, audioCodec: string, channels: number, sampleRate: number }|null>}
 */
export async function probeAudioFile(absPath) {
  try {
    const { stdout } = await execFileAsync(ffprobeBin(), [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,channels,sample_rate:stream_disposition=attached_pic',
      '-show_entries', 'format=format_name,duration',
      '-of', 'json',
      absPath,
    ], { timeout: 15000, maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(String(stdout || '{}'));
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const audio = streams.find((s) => s?.codec_type === 'audio');
    const hasVideo = streams.some(
      (s) => s?.codec_type === 'video' && Number(s?.disposition?.attached_pic || 0) !== 1,
    );
    const dur = Number(parsed?.format?.duration);
    return {
      formatName: String(parsed?.format?.format_name || '').toLowerCase(),
      durationSeconds: Number.isFinite(dur) && dur > 0 ? dur : undefined,
      hasAudio: Boolean(audio),
      hasVideo,
      audioCodec: String(audio?.codec_name || '').toLowerCase(),
      channels: Number(audio?.channels) || 0,
      sampleRate: Number(audio?.sample_rate) || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Probe media streams of an in-memory Buffer without leaving temp files behind.
 * @param {Buffer} buffer
 * @param {{ fileName?: string }} [opts]
 */
export async function probeMediaStreams(buffer, { fileName = '' } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const workDir = mkdtempSync(join(tmpdir(), 'wa-probe-'));
  try {
    const safeExt = sanitizeExt(fileName) || 'bin';
    const inPath = join(workDir, `input.${safeExt}`);
    writeFileSync(inPath, buffer);
    return await probeAudioFile(inPath);
  } catch {
    return null;
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Compute a 64-bar WhatsApp voice-note waveform (`Uint8Array` values 0..100) via `ffmpeg`.
 * Returns `undefined` if decoding fails.
 */
async function generateAudioWaveform(absPath) {
  try {
    const { stdout: pcmBuf } = await execFileAsync(ffmpegBin(), [
      '-v', 'error',
      '-i', absPath,
      '-ac', '1',
      '-ar', '2000',
      '-f', 's16le',
      'pipe:1',
    ], { encoding: 'buffer', timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
    if (!Buffer.isBuffer(pcmBuf) || pcmBuf.length < 2) return undefined;
    const sampleCount = Math.floor(pcmBuf.length / 2);
    const bars = 64;
    const blockSize = Math.max(1, Math.floor(sampleCount / bars));
    const filtered = [];
    for (let i = 0; i < bars; i++) {
      const start = i * blockSize;
      const end = Math.min(sampleCount, start + blockSize);
      if (start >= end) {
        filtered.push(0);
        continue;
      }
      let sum = 0;
      for (let j = start; j < end; j++) {
        sum += Math.abs(pcmBuf.readInt16LE(j * 2)) / 32768;
      }
      filtered.push(sum / (end - start));
    }
    const maxVal = Math.max(...filtered);
    const mult = maxVal > 0 ? 1 / maxVal : 0;
    return new Uint8Array(
      filtered.map((n) => Math.min(100, Math.max(0, Math.floor(100 * n * mult)))),
    );
  } catch {
    return undefined;
  }
}

function sanitizeExt(fileName) {
  const ext = (String(fileName || '').split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return ext && ext.length <= 8 ? ext : '';
}

function fallbackExtForAudio(mimeType, fileName) {
  const fromName = sanitizeExt(fileName);
  if (fromName && fromName !== 'bin' && fromName !== 'mp4') return fromName;
  return audioFileExt(mimeType);
}

/**
 * Prepare an outbound audio buffer so WhatsApp mobile clients (iOS + Android) and
 * desktop browsers both open, display duration, and play it cleanly.
 *
 * @param {Buffer} buffer
 * @param {{ mimeType?: string, fileName?: string, ptt?: boolean }} [opts]
 * @returns {Promise<{ buffer: Buffer, mimeType: string, ext: string, durationSeconds: number|undefined, waveform: Uint8Array|undefined, transcoded: boolean }>}
 */
export async function prepareOutboundAudioForWhatsApp(buffer, { mimeType = '', fileName = '', ptt = false } = {}) {
  const normMime = normalizeAudioMime(mimeType) || 'audio/mp4';
  const fallbackExt = fallbackExtForAudio(normMime, fileName);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return {
      buffer,
      mimeType: normMime,
      ext: fallbackExt,
      durationSeconds: undefined,
      waveform: undefined,
      transcoded: false,
    };
  }

  const workDir = mkdtempSync(join(tmpdir(), 'wa-audio-out-'));
  try {
    const inExt = sanitizeExt(fileName) || audioFileExt(normMime) || 'bin';
    const inPath = join(workDir, `in.${inExt}`);
    writeFileSync(inPath, buffer);

    const probe = await probeAudioFile(inPath);
    if (!probe) {
      return {
        buffer,
        mimeType: normMime,
        ext: fallbackExt,
        durationSeconds: undefined,
        waveform: undefined,
        transcoded: false,
      };
    }
    if (!probe.hasAudio) {
      throw new Error('Audio file contains no playable audio stream');
    }

    if (ptt) {
      const formats = probe.formatName.split(',');
      if (formats.includes('ogg') && probe.audioCodec === 'opus' && probe.channels === 1) {
        const waveform = await generateAudioWaveform(inPath);
        return {
          buffer,
          mimeType: 'audio/ogg; codecs=opus',
          ext: 'ogg',
          durationSeconds: probe.durationSeconds,
          waveform,
          transcoded: false,
        };
      }
      const outPath = join(workDir, 'voice.ogg');
      try {
        await execFileAsync(ffmpegBin(), [
          '-y',
          '-i', inPath,
          '-vn', '-dn', '-sn',
          '-c:a', 'libopus',
          '-b:a', '64k',
          '-ar', '48000',
          '-ac', '1',
          '-avoid_negative_ts', 'make_zero',
          '-application', 'voip',
          '-map_metadata', '-1',
          '-f', 'ogg',
          outPath,
        ], { timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
        if (existsSync(outPath) && statSync(outPath).size > 0) {
          const outProbe = await probeAudioFile(outPath);
          const waveform = await generateAudioWaveform(outPath);
          return {
            buffer: readFileSync(outPath),
            mimeType: 'audio/ogg; codecs=opus',
            ext: 'ogg',
            durationSeconds: outProbe?.durationSeconds ?? probe.durationSeconds,
            waveform,
            transcoded: true,
          };
        }
      } catch {
        // Fall through to original if libopus failed unexpectedly.
      }
      return {
        buffer,
        mimeType: normMime,
        ext: fallbackExt,
        durationSeconds: probe.durationSeconds,
        waveform: undefined,
        transcoded: false,
      };
    }

    // Non-PTT audio attachment / forward:
    const formats = probe.formatName.split(',');
    if (formats.includes('mp3') && probe.audioCodec === 'mp3') {
      return {
        buffer,
        mimeType: 'audio/mpeg',
        ext: 'mp3',
        durationSeconds: probe.durationSeconds,
        waveform: undefined,
        transcoded: false,
      };
    }

    const isMp4Family = formats.some((f) => f === 'mp4' || f === 'm4a' || f === 'mov');
    if (isMp4Family && probe.audioCodec === 'aac') {
      const m4aPath = join(workDir, 'remux.m4a');
      try {
        await execFileAsync(ffmpegBin(), [
          '-y',
          '-i', inPath,
          '-vn', '-dn', '-sn',
          '-c:a', 'copy',
          '-movflags', '+faststart',
          '-f', 'ipod',
          m4aPath,
        ], { timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
        if (existsSync(m4aPath) && statSync(m4aPath).size > 0) {
          const outProbe = await probeAudioFile(m4aPath);
          return {
            buffer: readFileSync(m4aPath),
            mimeType: 'audio/mp4',
            ext: 'm4a',
            durationSeconds: outProbe?.durationSeconds ?? probe.durationSeconds,
            waveform: undefined,
            transcoded: true,
          };
        }
      } catch {
        // Fall through to full transcode if stream-copy remux is incompatible.
      }
    }

    const channelClamp = probe.channels > 2 ? ['-ac', '2'] : [];
    const mp3Path = join(workDir, 'out.mp3');
    try {
      await execFileAsync(ffmpegBin(), [
        '-y',
        '-i', inPath,
        '-vn', '-dn', '-sn',
        ...channelClamp,
        '-c:a', 'libmp3lame',
        '-b:a', '128k',
        '-ar', '44100',
        '-map_metadata', '-1',
        '-id3v2_version', '3',
        '-f', 'mp3',
        mp3Path,
      ], { timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
      if (existsSync(mp3Path) && statSync(mp3Path).size > 0) {
        const outProbe = await probeAudioFile(mp3Path);
        return {
          buffer: readFileSync(mp3Path),
          mimeType: 'audio/mpeg',
          ext: 'mp3',
          durationSeconds: outProbe?.durationSeconds ?? probe.durationSeconds,
          waveform: undefined,
          transcoded: true,
        };
      }
    } catch {
      // Fall back to built-in AAC M4A encoder below.
    }

    const aacPath = join(workDir, 'out.m4a');
    try {
      await execFileAsync(ffmpegBin(), [
        '-y',
        '-i', inPath,
        '-vn', '-dn', '-sn',
        ...channelClamp,
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '44100',
        '-movflags', '+faststart',
        '-map_metadata', '-1',
        '-f', 'ipod',
        aacPath,
      ], { timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
      if (existsSync(aacPath) && statSync(aacPath).size > 0) {
        const outProbe = await probeAudioFile(aacPath);
        return {
          buffer: readFileSync(aacPath),
          mimeType: 'audio/mp4',
          ext: 'm4a',
          durationSeconds: outProbe?.durationSeconds ?? probe.durationSeconds,
          waveform: undefined,
          transcoded: true,
        };
      }
    } catch {
      // Fall back to original if both encoders fail.
    }

    return {
      buffer,
      mimeType: normMime,
      ext: fallbackExt,
      durationSeconds: probe.durationSeconds,
      waveform: undefined,
      transcoded: false,
    };
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Return a browser-playable audio path for `absPath`, transcoding Ogg Opus or
 * Opus-in-MP4 to fast-start AAC/m4a when needed. Returns `{ path, contentType }`
 * for the playable copy, or `{ path: absPath, contentType: null }` when no transcode
 * is required. On transcode failure it falls back to the original path so something
 * plays in browsers that support Ogg.
 *
 * @param {string} absPath absolute path under the media root
 * @returns {Promise<{ path: string, contentType: string|null }>}
 */
export async function playableAudioFor(absPath) {
  if (!needsPlayableAudioCopy(absPath)) return { path: absPath, contentType: null };
  const target = join(dirname(absPath), `${basenameNoExt(absPath)}${PLAY_SUFFIX}`);
  try {
    if (existsSync(target) && statSync(target).size > 0) {
      return { path: target, contentType: 'audio/mp4' };
    }
    await execFileAsync(ffmpegBin(), [
      '-y',
      '-i', absPath,
      '-vn',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-ar', '44100',
      '-movflags', '+faststart',
      '-f', 'ipod',
      target,
    ], { timeout: 30000, maxBuffer: 1024 * 1024 });
    if (existsSync(target) && statSync(target).size > 0) {
      return { path: target, contentType: 'audio/mp4' };
    }
  } catch {
    // Transcode failed (ffmpeg missing, read-only dir, corrupt file…) — fall
    // back to the original so Ogg-capable browsers still play it.
  }
  return { path: absPath, contentType: null };
}

function basenameNoExt(p) {
  const base = String(p).split(/[/\\]/).pop() || 'audio';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}
