/**
 * WhatsApp voice notes come in browser-hostile wraps:
 *  - Ogg Opus (`.ogg`/`.oga`/`.opus`): Safari cannot decode Ogg at all.
 *  - Opus in an MP4 container (`.mp4`/`.m4a` from some client variants):
 *    Safari has no Opus decoder and Chromium's opus-in-mp4 support is patchy.
 * To make voice notes playable everywhere, transcode any of these to
 * AAC/m4a on first serve and cache the result next to the original file.
 * (Genuine documents/other attachments are untouched — the route only asks
 * for playable copies of DB audio/ptt rows.)
 */
import { execFile } from 'child_process';
import { existsSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Suffix for the cached, browser-playable copy. */
const PLAY_SUFFIX = '.play.m4a';

/** On-disk extensions whose audio needs an AAC copy for universal playback. */
const NEEDS_PLAYABLE_COPY = new Set(['ogg', 'oga', 'opus', 'mp4', 'm4a']);

function ffmpegBin() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

export function needsPlayableAudioCopy(filePath) {
  const ext = (String(filePath).split('.').pop() || '').toLowerCase();
  return NEEDS_PLAYABLE_COPY.has(ext);
}

/**
 * Return a browser-playable audio path for `absPath`, transcoding Ogg Opus to
 * AAC/m4a when needed. Returns `{ path, contentType }` for the playable copy,
 * or `{ path: absPath, contentType: null }` when no transcode is required.
 * On transcode failure it falls back to the original path so something plays
 * in browsers that support Ogg.
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
      '-b:a', '64k',
      '-ar', '48000',
      '-ac', '1',
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
