import { describe, expect, test } from '@jest/globals';
import { _vnFmt, _vnNote, _vnAudio, _vnUpdate, buildChatMessagesHtml } from '../public/js/messages-render.js';

describe('Voice note player helper functions', () => {
  describe('_vnFmt', () => {
    test('formats valid durations correctly', () => {
      expect(_vnFmt(0)).toBe('0:00');
      expect(_vnFmt(5)).toBe('0:05');
      expect(_vnFmt(59)).toBe('0:59');
      expect(_vnFmt(60)).toBe('1:00');
      expect(_vnFmt(65)).toBe('1:05');
      expect(_vnFmt(125.7)).toBe('2:05');
    });

    test('handles invalid, infinite, or negative durations gracefully', () => {
      expect(_vnFmt(NaN)).toBe('0:00');
      expect(_vnFmt(Infinity)).toBe('0:00');
      expect(_vnFmt(-5)).toBe('0:00');
      expect(_vnFmt(null)).toBe('0:00');
      expect(_vnFmt(undefined)).toBe('0:00');
    });
  });

  describe('_vnNote and _vnAudio element resolution', () => {
    function mockElement(tag, className = '', children = [], parent = null) {
      const el = {
        tagName: tag.toUpperCase(),
        classList: {
          contains: (cls) => className.split(' ').includes(cls),
          toggle: (cls, val) => {},
        },
        className,
        parentElement: parent,
        children: [...children],
        dataset: {},
        attributes: {},
        setAttribute: (k, v) => { el.attributes[k] = v; },
        getAttribute: (k) => el.attributes[k],
        querySelector: (sel) => {
          for (const c of el.children) {
            if (sel === '.vn-audio' && c.className.includes('vn-audio')) return c;
            if (sel === '.wa-voice-note' && c.className.includes('wa-voice-note')) return c;
            if (sel === '.vn-play' && c.className.includes('vn-play')) return c;
            if (sel === '.vn-time' && c.className.includes('vn-time')) return c;
            if (sel === '.vn-icon-play' && c.className.includes('vn-icon-play')) return c;
            if (sel === '.vn-icon-pause' && c.className.includes('vn-icon-pause')) return c;
            const sub = c.querySelector?.(sel);
            if (sub) return sub;
          }
          return null;
        },
        querySelectorAll: (sel) => {
          const results = [];
          for (const c of el.children) {
            if (sel === '.vn-bar' && c.className.includes('vn-bar')) results.push(c);
            if (c.querySelectorAll) results.push(...c.querySelectorAll(sel));
          }
          return results;
        },
        closest: (sel) => {
          let curr = el;
          while (curr) {
            if (sel === '.wa-voice-note' && curr.className?.includes('wa-voice-note')) return curr;
            if (sel === '.media-wrap' && curr.className?.includes('media-wrap')) return curr;
            if (sel === '.vn-play' && curr.className?.includes('vn-play')) return curr;
            if (sel === '.vn-track' && curr.className?.includes('vn-track')) return curr;
            curr = curr.parentElement;
          }
          return null;
        },
      };
      children.forEach((c) => { c.parentElement = el; });
      return el;
    }

    test('resolves when audio is nested inside wa-voice-note', () => {
      const btn = mockElement('button', 'vn-play');
      const track = mockElement('span', 'vn-track');
      const time = mockElement('span', 'vn-time');
      const audio = mockElement('audio', 'vn-audio');
      const note = mockElement('span', 'wa-voice-note', [btn, track, time, audio]);
      const wrap = mockElement('span', 'media-wrap', [note]);

      expect(_vnAudio(btn)).toBe(audio);
      expect(_vnAudio(track)).toBe(audio);
      expect(_vnAudio(note)).toBe(audio);
      expect(_vnNote(audio)).toBe(note);
    });

    test('resolves when audio is sibling of wa-voice-note inside media-wrap', () => {
      const btn = mockElement('button', 'vn-play');
      const track = mockElement('span', 'vn-track');
      const time = mockElement('span', 'vn-time');
      const note = mockElement('span', 'wa-voice-note', [btn, track, time]);
      const audio = mockElement('audio', 'vn-audio');
      const wrap = mockElement('span', 'media-wrap', [note, audio]);

      expect(_vnAudio(btn)).toBe(audio);
      expect(_vnAudio(note)).toBe(audio);
      expect(_vnNote(audio)).toBe(note);
    });

    test('_vnUpdate toggles play/pause state and duration', () => {
      const playIcon = mockElement('svg', 'vn-icon-play');
      playIcon.style = {};
      const pauseIcon = mockElement('svg', 'vn-icon-pause');
      pauseIcon.style = {};
      const btn = mockElement('button', 'vn-play', [playIcon, pauseIcon]);
      const bars = [mockElement('span', 'vn-bar'), mockElement('span', 'vn-bar')];
      const track = mockElement('span', 'vn-track', bars);
      const time = mockElement('span', 'vn-time');
      const audio = mockElement('audio', 'vn-audio');
      const note = mockElement('span', 'wa-voice-note', [btn, track, time, audio]);

      // Paused state with duration
      audio.paused = true;
      audio.duration = 42;
      audio.currentTime = 0;
      _vnUpdate(note, audio);

      expect(time.textContent).toBe('0:42');
      expect(playIcon.style.display).toBe('');
      expect(pauseIcon.style.display).toBe('none');
      expect(btn.dataset.state).toBe('paused');

      // Playing state
      audio.paused = false;
      audio.currentTime = 15;
      _vnUpdate(note, audio);

      expect(time.textContent).toBe('0:15');
      expect(playIcon.style.display).toBe('none');
      expect(pauseIcon.style.display).toBe('');
      expect(btn.dataset.state).toBe('playing');
    });
  });

  describe('buildChatMessagesHtml audio output', () => {
    test('renders voice note pill with audio element inside wa-voice-note', () => {
      const msgs = [
        {
          messageId: 'mid-101',
          sender: '919876543210@s.whatsapp.net',
          chatJid: '919876543210@s.whatsapp.net',
          mediaType: 'audio',
          hasMediaFile: true,
          timestamp: 1700000000,
        },
      ];
      const html = buildChatMessagesHtml(msgs, '919876543210@s.whatsapp.net', null, null);

      expect(html).toContain('class="wa-voice-note"');
      expect(html).toContain('class="vn-play"');
      expect(html).toContain('class="vn-track"');
      expect(html).toContain('class="vn-audio"');

      // Ensure vn-audio is contained inside the wa-voice-note element
      const vnNoteStart = html.indexOf('<span class="wa-voice-note"');
      const vnNoteEnd = html.indexOf('</span>', html.indexOf('class="vn-audio"'));
      const audioIndex = html.indexOf('<audio class="vn-audio"');
      expect(audioIndex).toBeGreaterThan(vnNoteStart);
      expect(audioIndex).toBeLessThan(vnNoteEnd);
    });
  });
});
