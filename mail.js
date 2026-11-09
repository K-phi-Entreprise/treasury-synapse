'use strict';
/* Outgoing mail through Resend's HTTP API when RESEND_API_KEY and MAIL_FROM are set; otherwise logged only.
 * Nothing in the app depends on mail being configured. */
const configured = () => !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);

async function send({ to, subject, text }) {
  if (!to) return { sent: false, reason: 'no recipient' };
  if (!configured()) { console.log('[mail not configured] to=%s subject=%s', to, subject); return { sent: false, reason: 'not configured' }; }
  const r = await fetch((process.env.RESEND_BASE_URL || 'https://api.resend.com') + '/emails', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, text })
  });
  if (!r.ok) { console.error('mail failed', r.status, await r.text().catch(() => '')); return { sent: false, reason: 'provider ' + r.status }; }
  return { sent: true };
}

module.exports = { send, configured };
