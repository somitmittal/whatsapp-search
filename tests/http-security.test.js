import { describe, expect, test } from '@jest/globals';
import {
  defaultBindHost,
  isLoopbackHostname,
  isSafeExternalUrl,
  isTrustedBrowserOrigin,
  pathAllowsUnauthenticatedCrossOrigin,
} from '../src/web/http-security.js';

describe('http-security origin policy', () => {
  test('loopback hostnames', () => {
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('::1')).toBe(true);
    expect(isLoopbackHostname('evil.example')).toBe(false);
  });

  test('blocks random websites from reading the local API', () => {
    expect(isTrustedBrowserOrigin('https://evil.example', { isPublicInternet: false })).toBe(false);
    expect(isTrustedBrowserOrigin('http://127.0.0.1:3847', { isPublicInternet: false })).toBe(true);
    expect(isTrustedBrowserOrigin('http://localhost:3000', { isPublicInternet: false })).toBe(true);
  });

  test('loopback stays trusted so the desktop UI can talk to itself', () => {
    expect(isTrustedBrowserOrigin('http://127.0.0.1:3847', { isPublicInternet: true })).toBe(true);
    expect(isTrustedBrowserOrigin('http://localhost:3000', { isPublicInternet: false })).toBe(true);
  });

  test('allows the Render origin when configured', () => {
    expect(isTrustedBrowserOrigin('https://app.example.com', {
      isPublicInternet: true,
      renderOrigin: 'https://app.example.com',
    })).toBe(true);
    expect(isTrustedBrowserOrigin('https://other.example.com', {
      isPublicInternet: true,
      renderOrigin: 'https://app.example.com',
    })).toBe(false);
  });

  test('WhatsApp Web may only call extension ingest APIs locally', () => {
    expect(isTrustedBrowserOrigin('https://web.whatsapp.com', {
      isPublicInternet: false,
      path: '/api/extension/messages',
    })).toBe(true);
    expect(isTrustedBrowserOrigin('https://web.whatsapp.com', {
      isPublicInternet: false,
      path: '/api/chats',
    })).toBe(false);
  });

  test('missing origin is allowed (same-origin, health checks)', () => {
    expect(isTrustedBrowserOrigin('', { isPublicInternet: true })).toBe(true);
    expect(isTrustedBrowserOrigin(null, { isPublicInternet: false })).toBe(true);
  });

  test('webhook and health skip origin gate', () => {
    expect(pathAllowsUnauthenticatedCrossOrigin('/api/health')).toBe(true);
    expect(pathAllowsUnauthenticatedCrossOrigin('/api/waba/webhook')).toBe(true);
    expect(pathAllowsUnauthenticatedCrossOrigin('/api/chats')).toBe(false);
  });

  test('external open is https or same-port loopback', () => {
    expect(isSafeExternalUrl('https://ollama.com/download')).toBe(true);
    expect(isSafeExternalUrl('http://127.0.0.1:3847/x', { loopbackPort: 3847 })).toBe(true);
    expect(isSafeExternalUrl('http://127.0.0.1:9999/x', { loopbackPort: 3847 })).toBe(false);
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
  });

  test('default bind host is loopback unless public', () => {
    expect(defaultBindHost({ hostEnv: '', isPublicInternet: false })).toBe('127.0.0.1');
    expect(defaultBindHost({ hostEnv: '', isPublicInternet: true })).toBe('0.0.0.0');
    expect(defaultBindHost({ hostEnv: '0.0.0.0', isPublicInternet: false })).toBe('0.0.0.0');
  });
});
