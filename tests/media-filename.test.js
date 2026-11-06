import { describe, expect, test } from '@jest/globals';
import {
  attachmentFilenameFromMessage,
  contentTypeForMediaFile,
  downloadFilenameForServedMedia,
} from '../src/web/media-filename.js';

describe('media-filename', () => {
  test('contentTypeForMediaFile maps common audio and video extensions', () => {
    expect(contentTypeForMediaFile('/x/a.m4a')).toBe('audio/mp4');
    expect(contentTypeForMediaFile('/x/a.mp3')).toBe('audio/mpeg');
    expect(contentTypeForMediaFile('/x/a.ogg')).toBe('audio/ogg');
    expect(contentTypeForMediaFile('/x/a.webm')).toBe('video/webm');
    expect(contentTypeForMediaFile('/x/a.mp4')).toBe('video/mp4');
  });

  test('attachmentFilenameFromMessage keeps audio filenames from captions', () => {
    expect(attachmentFilenameFromMessage('/media/jid/3EB0.bin', '3EB0', 'song.mp3')).toBe('song.mp3');
    expect(attachmentFilenameFromMessage('/media/jid/3EB0.ogg', '3EB0', '')).toBe('3EB0.ogg');
    expect(attachmentFilenameFromMessage('/media/jid/3EB0.m4a', '3EB0', 'voice.m4a')).toBe('voice.m4a');
  });

  test('downloadFilenameForServedMedia renames transcoded voice notes to .m4a', () => {
    expect(downloadFilenameForServedMedia({
      fname: '3EB0.ogg',
      servePath: '/media/jid/3EB0.play.m4a',
      originalPath: '/media/jid/3EB0.ogg',
      mediaType: 'audio',
      contentType: 'audio/mp4',
    })).toBe('3EB0.m4a');
  });

  test('downloadFilenameForServedMedia never leaves audio rows with a .mp4 name', () => {
    expect(downloadFilenameForServedMedia({
      fname: '3EB0.mp4',
      servePath: '/media/jid/3EB0.mp4',
      originalPath: '/media/jid/3EB0.mp4',
      mediaType: 'audio',
      contentType: 'audio/mp4',
    })).toBe('3EB0.m4a');
  });

  test('downloadFilenameForServedMedia keeps real mp3 downloads', () => {
    expect(downloadFilenameForServedMedia({
      fname: 'track.mp3',
      servePath: '/media/jid/track.mp3',
      originalPath: '/media/jid/track.mp3',
      mediaType: 'audio',
      contentType: 'audio/mpeg',
    })).toBe('track.mp3');
  });
});
