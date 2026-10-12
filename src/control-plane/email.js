/**
 * Magic-link email delivery. Uses Resend when RESEND_API_KEY is set; otherwise logs the link.
 */

export async function sendMagicLinkEmail({ to, verifyUrl, code }) {
  const from = (process.env.CONTROL_PLANE_FROM_EMAIL || 'Searchable <onboarding@searchable.app>').trim();
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  const subject = 'Your Searchable sign-in code';
  const text = [
    'Sign in to Searchable (your chats stay on your device).',
    '',
    `One-time code: ${code}`,
    '',
    `Or open this link: ${verifyUrl}`,
    '',
    'This code expires in 30 minutes.',
  ].join('\n');
  const html = `
    <p>Sign in to <strong>Searchable</strong> — your chats stay on your device.</p>
    <p style="font-size:28px;letter-spacing:4px;font-weight:700">${code}</p>
    <p><a href="${verifyUrl}">Or click here to verify</a></p>
    <p style="color:#667781;font-size:13px">Expires in 30 minutes.</p>
  `;

  if (!apiKey) {
    console.log(`[control-plane] Magic link for ${to}: code=${code} url=${verifyUrl}`);
    return { ok: true, mode: 'log' };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: [to], subject, text, html }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return { ok: true, mode: 'resend' };
}
