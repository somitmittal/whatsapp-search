/**
 * Vercel serverless entry — Searchable control plane only.
 * Set CONTROL_PLANE_ONLY=1 and Turso + Resend env vars in the Vercel project.
 */
import { createControlPlaneApp } from '../src/control-plane/standalone-server.js';

export const config = {
  api: {
    // Stripe webhook needs the raw body; Express registers express.raw on that route.
    bodyParser: false,
  },
};

let appPromise;

export default async function handler(req, res) {
  if (!appPromise) {
    process.env.CONTROL_PLANE_ONLY = process.env.CONTROL_PLANE_ONLY || '1';
    appPromise = createControlPlaneApp();
  }
  const app = await appPromise;
  return app(req, res);
}
