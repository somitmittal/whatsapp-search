import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import { isValidControlPlaneEmail, registerControlPlaneRoutes, registerStripeWebhookRoute } from '../src/control-plane/routes.js';
import { getControlPlaneStore } from '../src/control-plane/store.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('control-plane security', () => {
  describe('isValidControlPlaneEmail', () => {
    it('accepts normal emails', () => {
      expect(isValidControlPlaneEmail('user@example.com')).toBe(true);
    });

    it('rejects HTML / quote injection in the local part', () => {
      expect(isValidControlPlaneEmail('"><img src=x onerror=alert(1)>@x.com')).toBe(false);
      expect(isValidControlPlaneEmail("a'<b>@x.com")).toBe(false);
      expect(isValidControlPlaneEmail('a@b')).toBe(false);
    });
  });

  describe('request-link / admin auth', () => {
    let dir;
    let store;
    let app;
    const prev = {};

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'cp-sec-'));
      store = getControlPlaneStore(join(dir, 'cp.db'));
      app = express();
      app.use(express.json());
      registerControlPlaneRoutes(app, { store });
      for (const k of ['RENDER', 'RENDER_EXTERNAL_URL', 'RESEND_API_KEY', 'CONTROL_PLANE_EXPOSE_DEV_CODE', 'SESSION_SECRET', 'JWT_SECRET', 'NODE_ENV']) {
        prev[k] = process.env[k];
      }
      process.env.SESSION_SECRET = 'test-session-secret-for-admin';
      process.env.NODE_ENV = 'test';
      delete process.env.RENDER;
      delete process.env.RENDER_EXTERNAL_URL;
      delete process.env.RESEND_API_KEY;
      delete process.env.CONTROL_PLANE_EXPOSE_DEV_CODE;
    });

    afterEach(() => {
      for (const [k, v] of Object.entries(prev)) {
        if (v == null) delete process.env[k];
        else process.env[k] = v;
      }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    function listen() {
      return new Promise((resolve) => {
        const server = app.listen(0, '127.0.0.1', () => {
          const { port } = server.address();
          resolve({ server, base: `http://127.0.0.1:${port}` });
        });
      });
    }

    it('does not return devCode on public deploys and requires Resend', async () => {
      process.env.RENDER = 'true';
      process.env.NODE_ENV = 'production';
      const { server, base } = await listen();
      try {
        const res = await fetch(`${base}/api/control/auth/request-link`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'victim@example.com' }),
        });
        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.devCode).toBeUndefined();
      } finally {
        server.close();
      }
    });

    it('rejects admin auth via query-string key', async () => {
      process.env.NODE_ENV = 'production';
      const { server, base } = await listen();
      try {
        const bad = await fetch(`${base}/api/analytics/downloads?key=test-session-secret-for-admin`);
        expect(bad.status).toBe(401);
        const good = await fetch(`${base}/api/analytics/downloads`, {
          headers: { Authorization: 'Bearer test-session-secret-for-admin' },
        });
        expect(good.status).toBe(200);
      } finally {
        server.close();
      }
    });
  });

  describe('stripe webhook', () => {
    it('rejects unsigned JSON bodies (no signature bypass)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cp-stripe-'));
      const store = getControlPlaneStore(join(dir, 'cp.db'));
      const app = express();
      registerStripeWebhookRoute(app, store);
      app.use(express.json());
      const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
      });
      const { port } = server.address();
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/control/webhooks/stripe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'checkout.session.completed',
            data: { object: { customer: 'cus_x', metadata: { userId: 'u1' } } },
          }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(String(body.error || '')).toMatch(/signature|raw|configured|Missing/i);
      } finally {
        server.close();
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  });
});
