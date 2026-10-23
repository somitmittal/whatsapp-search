/**
 * Minimal HTTP app: control plane + download/analytics only.
 * No WhatsApp, GPT UI, or chat DB — for Render / Vercel hosting.
 */
import cookieParser from 'cookie-parser';
import express from 'express';
import { createServer } from 'http';
import { resolve } from 'path';
import config from '../config.js';
import { publicDeployBaseUrl } from '../deploy-env.js';
import {
  applySecurityHeaders,
  applyTrustedCors,
  extraAllowedOriginsFromEnv,
  rejectUntrustedOrigin,
  renderPublicOrigin,
} from '../web/http-security.js';
import { ensureControlPlaneStore } from './store.js';
import { registerControlPlaneRoutes, registerStripeWebhookRoute } from './routes.js';
import { isLicenseGateEnabled } from './license-gate.js';
import { trialDays } from './license.js';
import { getLatestGitHubRelease, sendReleaseError } from '../releases/github-releases.js';

function isControlPlaneOnlyEnv() {
  return ['1', 'true', 'yes'].includes(String(process.env.CONTROL_PLANE_ONLY || '').trim().toLowerCase());
}

export { isControlPlaneOnlyEnv };

function originPolicy(req) {
  return {
    isPublicInternet: true,
    renderOrigin: renderPublicOrigin(),
    extraOrigins: [
      ...extraAllowedOriginsFromEnv(),
      process.env.CONTROL_PLANE_PUBLIC_URL || '',
      process.env.PUBLIC_WEB_URL || '',
      publicDeployBaseUrl() || '',
    ].filter(Boolean),
    path: req.path || '',
  };
}

/** Build the Express app (no listen) — used by Vercel and by startControlPlaneOnlyServer. */
export async function createControlPlaneApp() {
  const store = await ensureControlPlaneStore(config.controlPlaneDbPath);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    applySecurityHeaders(req, res);
    applyTrustedCors(req, res, originPolicy(req));
    if (req.method === 'OPTIONS') {
      if (rejectUntrustedOrigin(req, res, originPolicy(req))) return;
      return res.sendStatus(204);
    }
    if (rejectUntrustedOrigin(req, res, originPolicy(req))) return;
    next();
  });
  app.use(cookieParser());

  registerStripeWebhookRoute(app, store);
  app.use(express.json({ limit: '1mb' }));

  registerControlPlaneRoutes(app, { store });

  app.get('/health', (_req, res) => res.status(200).type('text/plain').send('ok'));
  app.get('/api/health', (_req, res) => res.status(200).json({ ok: true, controlPlaneOnly: true }));

  app.get('/api/app-config', (_req, res) => {
    res.json({
      controlPlaneOnly: true,
      desktop: false,
      appVersion: config.appVersion || '',
      controlPlaneUrl: config.controlPlaneUrl || publicDeployBaseUrl() || '',
      licenseGate: isLicenseGateEnabled(),
      trialDays: trialDays(),
      stripeEnabled: Boolean(
        (process.env.STRIPE_SECRET_KEY || '').trim()
        && (process.env.STRIPE_PRICE_ID || '').trim(),
      ),
    });
  });

  app.get('/download', (_req, res) => {
    res.sendFile(resolve(config.publicDir, 'download.html'));
  });

  app.get('/api/releases/latest', async (_req, res) => {
    const repo = config.githubRepo;
    try {
      return res.json(await getLatestGitHubRelease(repo));
    } catch (err) {
      return sendReleaseError(res, err, repo);
    }
  });

  app.get('/', (_req, res) => res.redirect(302, '/download'));

  app.get(['/gpt', '/gpt.html', '/index.html'], (_req, res) => {
    res.status(404).type('text/plain').send('This host is the Searchable control plane only. Use the desktop app.');
  });
  app.use('/api', (req, res, next) => {
    const p = req.path || '';
    if (
      p.startsWith('/control/')
      || p === '/health'
      || p === '/app-config'
      || p === '/analytics/downloads'
      || p.startsWith('/releases/')
    ) {
      return next();
    }
    return res.status(404).json({
      error: 'Not available on control-plane host',
      code: 'control_plane_only',
    });
  });

  return app;
}

export async function startControlPlaneOnlyServer() {
  const app = await createControlPlaneApp();
  const server = createServer(app);
  const host = config.webHost || '0.0.0.0';
  const port = config.webPort;
  await new Promise((resolve) => {
    server.listen(port, host, () => {
      const publicUrl = publicDeployBaseUrl() || `http://localhost:${port}`;
      console.log('[control-plane] CONTROL_PLANE_ONLY — no GPT/WhatsApp UI');
      console.log(`[control-plane] Listening on ${host}:${port}`);
      console.log(`[control-plane] Public: ${publicUrl}`);
      console.log(`[control-plane] Admin: ${publicUrl}/analytics`);
      console.log(`[control-plane] Download: ${publicUrl}/download`);
      resolve();
    });
  });

  return server;
}
