import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  captureChatScrollAnchor,
  restoreChatScroll,
  scrollChatToBottom,
} from '../public/js/messages-render.js';

describe('chat transcript scroll-to-bottom', () => {
  const rafQueue = [];
  const realRaf = global.requestAnimationFrame;
  const realCancel = global.cancelAnimationFrame;

  beforeEach(() => {
    rafQueue.length = 0;
    global.requestAnimationFrame = (cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    };
    global.cancelAnimationFrame = (id) => {
      if (id >= 1 && id <= rafQueue.length) rafQueue[id - 1] = null;
    };
  });

  afterEach(() => {
    global.requestAnimationFrame = realRaf;
    global.cancelAnimationFrame = realCancel;
  });

  function flushRaf() {
    const q = rafQueue.splice(0, rafQueue.length);
    for (const cb of q) if (typeof cb === 'function') cb(0);
  }

  function fakeContainer({ scrollHeight = 4000, clientHeight = 600, scrollTop = 0 } = {}) {
    return {
      scrollTop,
      scrollHeight,
      clientHeight,
      querySelectorAll: () => [],
    };
  }

  it('scrollChatToBottom sets scrollTop to scrollHeight immediately and on rAF', () => {
    const el = fakeContainer({ scrollHeight: 5000, scrollTop: 10 });
    scrollChatToBottom(el, { frames: 2 });
    expect(el.scrollTop).toBe(5000);

    el.scrollHeight = 5600; // layout grew after paint
    flushRaf();
    expect(el.scrollTop).toBe(5600);

    el.scrollHeight = 5900;
    flushRaf();
    expect(el.scrollTop).toBe(5900);
  });

  it('restoreChatScroll force uses stick-to-bottom helper', () => {
    const el = fakeContainer({ scrollHeight: 3000, scrollTop: 0 });
    restoreChatScroll(el, { mode: 'top', scrollTop: 40 }, { force: true });
    expect(el.scrollTop).toBe(3000);
  });

  it('captureChatScrollAnchor reports bottom when near live edge', () => {
    const el = fakeContainer({ scrollHeight: 2000, clientHeight: 600, scrollTop: 1950 });
    el.querySelectorAll = () => [];
    expect(captureChatScrollAnchor(el)).toEqual({ mode: 'bottom' });
  });
});
