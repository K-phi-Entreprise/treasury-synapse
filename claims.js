'use strict';
/* Claimed cards: a person proves they are a card with a link sent to their work email.
 * - The email's domain must match the organisation on the card (or the site the card's sources come from);
 *   personal addresses, mismatches and cards already claimed by another address go to the review queue instead.
 * - Confirming the link claims the card and signs the browser in with a signed cookie (no password, no account).
 * - On another device, the person asks for a sign-in link sent to the confirmed address.
 * The claim says nothing about the evidence: links and bubble size still come only from public pages. */
const crypto = require('crypto');

const FREEMAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.fr', 'hotmail.co.uk', 'live.com', 'live.fr', 'msn.com',
  'yahoo.com', 'yahoo.fr', 'yahoo.co.uk', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me',
  'gmx.com', 'gmx.de', 'gmx.net', 'web.de', 't-online.de', 'orange.fr', 'free.fr', 'laposte.net', 'sfr.fr', 'wanadoo.fr', 'yandex.com', 'yandex.ru',
  'mail.ru', 'mail.com', 'qq.com', '163.com', 'hey.com', 'fastmail.com', 'tutanota.com', 'zoho.com', 'seznam.cz', 'libero.it', 'virgilio.it', 'freenet.de']);
const TWO_LEVEL = /\.(co|com|org|net|ac|gov|ltd|plc)\.[a-z]{2}$/i;
const STOP = new Set(['inc', 'ltd', 'llc', 'gmbh', 'sa', 'sas', 'ag', 'plc', 'group', 'the', 'and', 'co', 'corp', 'corporation', 'limited', 'bv', 'nv', 'spa', 'srl', 'kft', 'ab', 'oy', 'as', 'se', 'holding', 'holdings', 'international', 'global', 'company']);
const TTL = { claim: 24 * 3600e3, login: 3600e3 };
const COOKIE = 'syn_card', COOKIE_DAYS = 180;

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/* the label a company registers: nomentia.com -> nomentia, ing.co.uk -> ing, eu.kyriba.com -> kyriba */
function brand(host) {
  const h = norm(host).replace(/^www\./, '').replace(/\.$/, '');
  const parts = h.split('.');
  if (parts.length < 2) return '';
  return TWO_LEVEL.test(h) && parts.length >= 3 ? parts[parts.length - 3] : parts[parts.length - 2];
}
const orgTokens = s => norm(s).split(/[^a-z0-9]+/).filter(t => t.length > 1 && !STOP.has(t));

/* does an email domain belong to this card's organisation? */
function domainMatches(email, person, hosts) {
  const domain = String(email).split('@')[1] || '';
  if (FREEMAIL.has(domain.toLowerCase())) return { ok: false, reason: 'personal address' };
  const b = brand(domain);
  if (!b || b.length < 2) return { ok: false, reason: 'unknown domain' };
  const toks = orgTokens(person.org).concat(orgTokens((person.headline || '').split(/[,;·]/)[0] || ''));
  const joined = orgTokens(person.org).join('');
  const hit = (joined && (joined === b || (b.length >= 4 && joined.startsWith(b)) || (joined.length >= 4 && b.startsWith(joined))))
    || toks.some(t => t.length >= 3 && (t === b || (t.length >= 4 && b.length >= 4 && (b.startsWith(t) || t.startsWith(b)))))
    || hosts.some(h => brand(h) === b);
  return hit ? { ok: true } : { ok: false, reason: 'domain does not match the organisation on the card' };
}

function mount(app, { pool, mail, ipHash, underQuota, publicUrl, secret, emailRe, onChange }) {
  const key = crypto.createHash('sha256').update('card|' + secret).digest();
  const sign = v => crypto.createHmac('sha256', key).update(v).digest('base64url').slice(0, 32);
  const makeCookie = (id) => { const exp = Date.now() + COOKIE_DAYS * 864e5; const v = id + '.' + exp; return v + '.' + sign(v); };
  function readCookie(req) {
    const raw = String(req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(COOKIE + '='));
    if (!raw) return null;
    const v = decodeURIComponent(raw.slice(COOKIE.length + 1)), i = v.lastIndexOf('.');
    if (i < 0) return null;
    const body = v.slice(0, i), sig = v.slice(i + 1), want = sign(body);
    if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
    const [id, exp] = [body.slice(0, body.lastIndexOf('.')), Number(body.slice(body.lastIndexOf('.') + 1))];
    return exp > Date.now() ? id : null;
  }
  const setCookie = (req, res, val, maxAge) => res.append('Set-Cookie', COOKIE + '=' + encodeURIComponent(val) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + (req.secure ? '; Secure' : ''));

  async function token(personId, email, purpose) {
    const t = crypto.randomBytes(24).toString('base64url');
    await pool.query('insert into claim_tokens (token, person_id, email, purpose, expires_at) values ($1,$2,$3,$4,$5)', [t, personId, email, purpose, new Date(Date.now() + TTL[purpose])]);
    return t;
  }
  async function hostsFor(id) {
    const r = await pool.query(`select p.source as u from people p where p.id = $1
      union select r.url from person_roles r where r.person_id = $1 union select s.url from person_systems s where s.person_id = $1 and s.role = 'sells'`, [id]);
    return r.rows.map(x => { try { return new URL(x.u).hostname; } catch (e) { return ''; } }).filter(Boolean);
  }

  /* who is signed in on this browser */
  async function me(req) {
    const id = readCookie(req);
    if (!id) return null;
    const r = await pool.query('select p.id, p.name, c.email from claims c join people p on p.id = c.person_id where c.person_id = $1 and c.confirmed_at is not null and not p.hidden', [id]);
    return r.rows[0] || null;
  }

  app.post('/api/claims', async (req, res, next) => {
    try {
      const personId = String(req.body.personId || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 120);
      const email = String(req.body.email || '').trim().toLowerCase().slice(0, 200);
      if (!personId) return res.status(400).json({ error: 'which card is this?' });
      if (!emailRe.test(email)) return res.status(400).json({ error: 'that email address does not look right' });
      const p = (await pool.query('select id, name, org, headline from people where id = $1 and not hidden', [personId])).rows[0];
      if (!p) return res.status(404).json({ error: 'unknown person' });
      if (!(await underQuota(req, 'claim'))) return res.status(429).json({ error: 'daily limit reached, try again tomorrow' });
      const cur = (await pool.query('select email from claims where person_id = $1 and confirmed_at is not null', [personId])).rows[0];
      let m = cur && cur.email !== email ? { ok: false, reason: 'card already claimed by another address' } : domainMatches(email, p, await hostsFor(personId));
      if (m.ok) {
        const t = await token(personId, email, 'claim');
        const sent = await mail.send({ to: email, subject: 'Treasury Synapse: confirm this is your card',
          text: 'Hello,\n\nSomeone (hopefully you) asked to claim the card of ' + p.name + ' on Treasury Synapse.\n\nConfirm it here (valid 24 hours):\n' + publicUrl + '/api/claim/' + t +
            '\n\nOnce confirmed, you can say on your card what you have worked on, which systems you know and whether you are open to a reference call. Nothing changes on the map until you confirm.\n\nIf this was not you, ignore this message.\n\nTreasury Synapse, by K-phi\n' });
        return res.json({ status: 'sent', mail: sent.sent ? 'sent' : 'not sent' });
      }
      /* not provable by domain: a person reviews it; the email is still confirmed first */
      const t = crypto.randomBytes(18).toString('base64url');
      const r = await pool.query("insert into submissions (kind, person_id, payload, email, ip_hash, confirm_token) values ('claim',$1,$2,$3,$4,$5) returning id",
        [personId, JSON.stringify({ reason: m.reason, note: String(req.body.note || '').slice(0, 600) }), email, ipHash(req), t]);
      const sent = await mail.send({ to: email, subject: 'Treasury Synapse: please confirm your request',
        text: 'Hello,\n\nSomeone (hopefully you) asked to claim the card of ' + p.name + ' with this address. It needs a quick check by a person (' + m.reason + ').\n\nConfirm the request here:\n' + publicUrl + '/api/confirm/' + t +
          '\n\nYou will get a sign-in link once it has been reviewed.\n\nTreasury Synapse, by K-phi\n' });
      res.json({ status: 'review', reason: m.reason, id: r.rows[0].id, mail: sent.sent ? 'sent' : 'not sent' });
    } catch (e) { next(e); }
  });

  /* the link from the email: claim (or sign in), set the cookie, back to the map on the card */
  app.get('/api/claim/:token', async (req, res, next) => {
    try {
      const t = String(req.params.token).slice(0, 64);
      const r = await pool.query("update claim_tokens set used_at = now() where token = $1 and used_at is null and expires_at > now() returning *", [t]);
      const row = r.rows[0];
      const page = (title, body) => res.set('X-Robots-Tag', 'noindex').type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Treasury Synapse</title>' +
        '<body style="background:#080b17;color:#e8ecff;font:16px system-ui;padding:40px 20px;max-width:560px;margin:auto"><h1 style="font-size:22px">' + title + '</h1>' + body + '<p><a style="color:#6ee7f0" href="/">Back to the map</a></p>');
      if (!row) return page('Link not recognised', '<p>This link is not valid, has expired or has already been used. Ask for a new one from your card.</p>');
      const p = (await pool.query('select id from people where id = $1 and not hidden', [row.person_id])).rows[0];
      if (!p) return page('Card not found', '<p>This card is no longer on the map.</p>');
      if (row.purpose === 'claim') {
        await pool.query(`insert into claims (person_id, email, method, confirmed_at) values ($1,$2,'domain',now())
          on conflict (person_id) do update set email = excluded.email, method = excluded.method, confirmed_at = now()`, [row.person_id, row.email]);
        await pool.query('update people set updated_at = now() where id = $1', [row.person_id]);
        if (onChange) onChange();
      }
      setCookie(req, res, makeCookie(row.person_id), COOKIE_DAYS * 86400);
      res.redirect(302, '/?card=' + encodeURIComponent(row.person_id) + (row.purpose === 'claim' ? '&claimed=1' : ''));
    } catch (e) { next(e); }
  });

  /* another device: a sign-in link to the address that claimed the card. Same answer whatever the address, so it reveals nothing. */
  app.post('/api/claims/login', async (req, res, next) => {
    try {
      const email = String(req.body.email || '').trim().toLowerCase().slice(0, 200);
      if (!emailRe.test(email)) return res.status(400).json({ error: 'that email address does not look right' });
      if (!(await underQuota(req, 'claim'))) return res.status(429).json({ error: 'daily limit reached, try again tomorrow' });
      const rows = (await pool.query('select c.person_id, p.name from claims c join people p on p.id = c.person_id where c.email = $1 and c.confirmed_at is not null and not p.hidden', [email])).rows;
      for (const r of rows.slice(0, 3)) {
        const t = await token(r.person_id, email, 'login');
        await mail.send({ to: email, subject: 'Treasury Synapse: your sign-in link',
          text: 'Hello,\n\nHere is your link to sign in to the card of ' + r.name + ' (valid 1 hour):\n' + publicUrl + '/api/claim/' + t + '\n\nIf you did not ask for it, ignore this message.\n\nTreasury Synapse, by K-phi\n' });
      }
      res.json({ status: 'sent-if-known' });
    } catch (e) { next(e); }
  });

  app.get('/api/me', async (req, res, next) => {
    try { res.set('Cache-Control', 'no-store'); const m = await me(req); res.json(m ? { personId: m.id, name: m.name, email: m.email } : {}); } catch (e) { next(e); }
  });
  app.post('/api/me/logout', (req, res) => { setCookie(req, res, '', 0); res.json({ ok: true }); });

  /* ids of claimed cards, small enough to fetch on load */
  app.get('/api/claimed', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-cache'); /* a card just claimed must show at once */
      const r = await pool.query('select person_id from claims where confirmed_at is not null');
      res.json({ ids: r.rows.map(x => x.person_id) });
    } catch (e) { next(e); }
  });

  return { me, domainMatches, brand };
}

module.exports = { mount, domainMatches, brand };
