/** Voice-note playback guarantees: which on-disk files get a playable AAC copy. */
import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import { needsPlayableAudioCopy, playableAudioFor } from '../src/web/audio-transcode.js';

describe('audio-transcode', () => {
  const originalEnv = process.env.FFMPEG_PATH;
  beforeEach(() => {
    process.env.FFMPEG_PATH = '/bin/false'; // 1-exit binary → transcode always fails
  });
  afterEach(() => {
    process.env.FFMPEG_PATH = originalEnv;
  });

  test('voice-note containers all request a playable copy', () => {
    for (const ext of ['ogg', 'oga', 'opus', 'mp4', 'm4a']) {
      expect(needsPlayableAudioCopy(`note.${ext}`)).toBe(true);
    }
  });

  test('plain-playable formats pass through untouched', () => {
    for (const name of ['clip.mp3', 'tone.wav', 'audio.aac', 'song.flac', 'doc.pdf', 'vid.webm']) {
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
});
