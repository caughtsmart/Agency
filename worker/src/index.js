/**
 * Workings — lead capture Worker.
 *
 * Routes
 *   POST /api/lead    Accepts an audit submission from the site.
 *   POST /api/contact Accepts a plain contact-form message (name/email/message).
 *   GET  /api/leads   Returns recent submissions as JSON. Requires ?key=<ADMIN_KEY>.
 *
 * Bindings (wrangler.toml)
 *   DB                D1 database. Schema in ../schema.sql
 *   EMAIL             Cloudflare Email Routing send binding. Free, and only
 *                     able to reach verified destinations — which is all this
 *                     needs, because the only recipient is Graham.
 *
 * Secrets (`wrangler secret put NAME`) — never commit these
 *   NOTIFY_EMAIL      Where the [LEAD] notification goes. Must be a verified
 *                     Email Routing destination.
 *   FROM_EMAIL        Sending address on the site's own domain.
 *   ADMIN_KEY         Long random string guarding GET /api/leads.
 *   RATE_SALT         Long random string. Salts the IP hash used for rate limiting.
 *
 * Vars
 *   ALLOWED_ORIGIN    e.g. https://theworkings.uk — the only origin CORS is opened to.
 */

const RATE_LIMIT = 5;              // submissions
const RATE_WINDOW_SECONDS = 3600;  // per hour
const MAX_BODY_BYTES = 8 * 1024;

/* Small, deliberately unambitious blocklist. A determined person gets through;
   that is fine, this only has to stop the lazy 95%. */
const DISPOSABLE_DOMAINS = new Set([
  '0-mail.com', '10minutemail.com', '20minutemail.com', '33mail.com',
  'anonbox.net', 'byom.de', 'cock.li', 'discard.email', 'dispostable.com',
  'emailondeck.com', 'fakeinbox.com', 'fakemail.net', 'getairmail.com',
  'getnada.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org',
  'inboxkitten.com', 'jetable.org', 'maildrop.cc', 'mailinator.com',
  'mailnesia.com', 'mailsac.com', 'mintemail.com', 'moakt.com', 'mohmal.com',
  'mytemp.email', 'nowmymail.com', 'sharklasers.com', 'spam4.me',
  'spamgourmet.com', 'temp-mail.io', 'temp-mail.org', 'tempinbox.com',
  'tempmail.com', 'tempmail.net', 'tempmailo.com', 'tempr.email',
  'throwawaymail.com', 'trashmail.com', 'trashmail.de', 'yopmail.com',
  'yopmail.net', 'wegwerfmail.de'
]);

const TASK_ORDER = [
  'Data re-entry',
  'Quoting & purchasing',
  'Repeat customer questions',
  'Stock & reconciliation',
  'Reporting',
  'Marketing production'
];

export default {
  /**
   * Daily cron (see wrangler.toml). Enforces the two retention promises the
   * privacy notice makes, so neither depends on anyone remembering:
   *   - audit submissions deleted after 24 months
   *   - rate-limit fingerprints deleted within hours of expiring
   */
  async scheduled(event, env, ctx) {
    const cutoffLeads = new Date(Date.now() - 24 * 30.44 * 24 * 3600 * 1000).toISOString();
    const cutoffHits = Math.floor(Date.now() / 1000) - RATE_WINDOW_SECONDS * 2;
    ctx.waitUntil(
      env.DB.batch([
        env.DB.prepare(`DELETE FROM leads WHERE created_at < ?1`).bind(cutoffLeads),
        env.DB.prepare(`DELETE FROM messages WHERE created_at < ?1`).bind(cutoffLeads),
        env.DB.prepare(`DELETE FROM rate_hits WHERE ts < ?1`).bind(cutoffHits)
      ]).catch(err => console.error('retention sweep failed', err && err.message))
    );
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return preflight(request, env);
    }

    if (url.pathname === '/api/lead' && request.method === 'POST') {
      try {
        return await handleLead(request, env, ctx);
      } catch (err) {
        console.error('lead handler failed', err && err.stack ? err.stack : err);
        return json({ ok: false, error: 'server_error' }, 500, request, env);
      }
    }

    if (url.pathname === '/api/contact' && request.method === 'POST') {
      try {
        return await handleContact(request, env, ctx);
      } catch (err) {
        console.error('contact handler failed', err && err.stack ? err.stack : err);
        return json({ ok: false, error: 'server_error' }, 500, request, env);
      }
    }

    if (url.pathname === '/api/leads' && request.method === 'GET') {
      try {
        return await handleList(request, env, url);
      } catch (err) {
        console.error('list handler failed', err && err.stack ? err.stack : err);
        return json({ ok: false, error: 'server_error' }, 500, request, env);
      }
    }

    if (url.pathname === '/api/lead' || url.pathname === '/api/contact' || url.pathname === '/api/leads') {
      return json({ ok: false, error: 'method_not_allowed' }, 405, request, env);
    }

    return json({ ok: false, error: 'not_found' }, 404, request, env);
  }
};

/* ------------------------------------------------------------------ *
 * POST /api/lead
 * ------------------------------------------------------------------ */

async function handleLead(request, env, ctx) {
  /* 0. Same-origin gate. Browsers attach an Origin header to every cross-site
        POST; if one turns up that isn't ours, refuse before doing any work.
        This matters because a "text/plain" POST skips the CORS preflight
        entirely — checking Origin here is what actually closes that door.
        Requests with no Origin header (curl, server-to-server) pass through
        and take their chances with the rate limiter. */
  const origin = request.headers.get('Origin');
  if (origin && !allowedOrigins(env).includes(origin)) {
    return json({ ok: false, error: 'forbidden' }, 403, request, env);
  }

  /* 1. Body size guard, in actual bytes, before parsing anything. */
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) {
    return json({ ok: false, error: 'payload_too_large' }, 413, request, env);
  }

  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: 'payload_too_large' }, 413, request, env);
  }
  const raw = new TextDecoder().decode(buf);

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400, request, env);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ ok: false, error: 'bad_json' }, 400, request, env);
  }

  /* 2. Rate limit by IP, before doing any real work. Every attempt counts,
        so a bot hammering the endpoint gets throttled whatever it sends.
        The hit is recorded and counted in one atomic batch — record first,
        then look at the total — so a burst of concurrent requests can't all
        read a stale count and slip past together. */
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipKey = await hashIp(rateKeyFor(ip), env.RATE_SALT || warnDefaultSalt());
  const attempts = await recordAndCount(env, ipKey);
  if (attempts > RATE_LIMIT) {
    return json({ ok: false, error: 'rate_limited' }, 429, request, env);
  }

  /* 3. Honeypot. Real people never see this field, so if it has anything in it
        — or the form was "filled in" in under a second and a half — bin it
        quietly. A bot that gets a 400 learns something; a bot that gets a 200
        learns nothing and goes away happy. The elapsed check only applies when
        the field is genuinely a number: null or "" must not coerce to 0 and
        silently bin a real person's submission. */
  const honeypot = typeof body.website === 'string' ? body.website.trim() : '';
  const tooFast = typeof body.elapsed === 'number' &&
    Number.isFinite(body.elapsed) && body.elapsed >= 0 && body.elapsed < 1500;
  if (honeypot !== '' || tooFast) {
    return json({ ok: true }, 200, request, env);
  }

  /* 4. Email. */
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!isValidEmail(email)) {
    return json({ ok: false, error: 'invalid_email' }, 400, request, env);
  }
  const domain = email.slice(email.lastIndexOf('@') + 1);
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return json({ ok: false, error: 'disposable_email' }, 400, request, env);
  }

  /* 5. Company and source. */
  const company = clean(body.company, 120) || '';
  const source = clean(body.source, 60) || 'unknown';

  /* 6. Audit figures. Recomputed from the parts rather than trusted, so a
        doctored payload cannot put a silly number in the subject line. */
  const audit = normaliseAudit(body.audit);
  if (!audit) {
    return json({ ok: false, error: 'invalid_audit' }, 400, request, env);
  }

  /* 7. Store. Truncated IP only — the full one is never written down. */
  const ipTrunc = truncateIp(ip);
  const ua = clean(request.headers.get('user-agent'), 200) || '';
  const createdAt = new Date().toISOString();

  let leadId = null;
  try {
    const res = await env.DB.prepare(
      `INSERT INTO leads
         (created_at, email, company, source, total, recoverable, hours, rate, weeks, tasks_json, ip_trunc, user_agent, notified)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0)`
    ).bind(
      createdAt, email, company, source,
      audit.total, audit.recoverable, audit.hours, audit.rate, audit.weeks,
      JSON.stringify(audit.tasks), ipTrunc, ua
    ).run();
    leadId = res && res.meta ? res.meta.last_row_id : null;
  } catch (err) {
    console.error('D1 insert failed', err && err.message);
    return json({ ok: false, error: 'storage_failed' }, 500, request, env);
  }

  /* 8. Tell Graham. Deliberately after the write: if mail is having a bad day
        the lead is already safe, and the notified flag on the row shows up on
        the leads page. There is no auto-acknowledgement to the submitter —
        Cloudflare only sends to verified destinations, and the page already
        says he will reply personally. His reply is the acknowledgement. */
  ctx.waitUntil(notify(env, { leadId, email, company, source, audit, createdAt, ipTrunc }));

  return json({ ok: true }, 200, request, env);
}

/* ------------------------------------------------------------------ *
 * POST /api/contact
 *
 * The plain-message twin of /api/lead, for people who'd rather just say what
 * they want than run the audit first. Same guards, same store-then-email
 * pattern, same reply-to trick — only the payload is simpler: a name, an email
 * and a free-text message. There is no audit to recompute and nothing derived,
 * so the message is stored close to verbatim (newlines kept).
 * ------------------------------------------------------------------ */

async function handleContact(request, env, ctx) {
  /* 0. Same-origin gate — identical reasoning to handleLead. */
  const origin = request.headers.get('Origin');
  if (origin && !allowedOrigins(env).includes(origin)) {
    return json({ ok: false, error: 'forbidden' }, 403, request, env);
  }

  /* 1. Body size guard, in bytes, before parsing. */
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) {
    return json({ ok: false, error: 'payload_too_large' }, 413, request, env);
  }
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: 'payload_too_large' }, 413, request, env);
  }
  const raw = new TextDecoder().decode(buf);

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400, request, env);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ ok: false, error: 'bad_json' }, 400, request, env);
  }

  /* 2. Rate limit by IP — the same rolling-hour window and the same rate_hits
        table as /api/lead, so a bot that hammers either endpoint is throttled
        across both. */
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipKey = await hashIp(rateKeyFor(ip), env.RATE_SALT || warnDefaultSalt());
  const attempts = await recordAndCount(env, ipKey);
  if (attempts > RATE_LIMIT) {
    return json({ ok: false, error: 'rate_limited' }, 429, request, env);
  }

  /* 3. Honeypot + "filled in impossibly fast" check. A bot gets a cheerful 200
        and learns nothing; see the long note in handleLead. */
  const honeypot = typeof body.website === 'string' ? body.website.trim() : '';
  const tooFast = typeof body.elapsed === 'number' &&
    Number.isFinite(body.elapsed) && body.elapsed >= 0 && body.elapsed < 1500;
  if (honeypot !== '' || tooFast) {
    return json({ ok: true }, 200, request, env);
  }

  /* 4. Email — same validation and disposable-domain block as a lead. */
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!isValidEmail(email)) {
    return json({ ok: false, error: 'invalid_email' }, 400, request, env);
  }
  const domain = email.slice(email.lastIndexOf('@') + 1);
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return json({ ok: false, error: 'disposable_email' }, 400, request, env);
  }

  /* 5. Name (optional), source, and the message itself. */
  const name = clean(body.name, 80) || '';
  const source = clean(body.source, 60) || 'contact';
  const message = cleanMessage(body.message, 4000);
  if (message.length < 2) {
    return json({ ok: false, error: 'invalid_message' }, 400, request, env);
  }

  /* 6. Store first, exactly like a lead: if mail is having a bad day the
        message is already safe in the messages table, with notified = 0 to
        show it never got out. (admin.html lists leads only, not messages.) */
  const ipTrunc = truncateIp(ip);
  const ua = clean(request.headers.get('user-agent'), 200) || '';
  const createdAt = new Date().toISOString();

  let msgId = null;
  try {
    const res = await env.DB.prepare(
      `INSERT INTO messages
         (created_at, name, email, message, source, ip_trunc, user_agent, notified)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)`
    ).bind(createdAt, name, email, message, source, ipTrunc, ua).run();
    msgId = res && res.meta ? res.meta.last_row_id : null;
  } catch (err) {
    console.error('D1 insert failed (message)', err && err.message);
    return json({ ok: false, error: 'storage_failed' }, 500, request, env);
  }

  /* 7. Tell Graham. replyTo is the sender, so hitting reply answers them. */
  ctx.waitUntil(notifyContact(env, { msgId, name, email, message, source, createdAt, ipTrunc }));

  return json({ ok: true }, 200, request, env);
}

/* ------------------------------------------------------------------ *
 * GET /api/leads?key=…
 * ------------------------------------------------------------------ */

async function handleList(request, env, url) {
  /* The key travels in a header, never the query string — request URLs end up
     in Cloudflare's logs and in browser history; header values do not. */
  const key = request.headers.get('X-Admin-Key') || '';
  if (!env.ADMIN_KEY || !(await keysMatch(key, env.ADMIN_KEY))) {
    return json({ ok: false, error: 'unauthorised' }, 401, request, env);
  }

  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 200);
  const { results } = await env.DB.prepare(
    `SELECT id, created_at, email, company, source, total, recoverable, hours, rate, weeks, tasks_json, notified
       FROM leads ORDER BY id DESC LIMIT ?1`
  ).bind(limit).all();

  const leads = (results || []).map(r => ({
    ...r,
    tasks: safeParse(r.tasks_json),
    tasks_json: undefined
  }));

  return json({ ok: true, count: leads.length, leads }, 200, request, env);
}

/* ------------------------------------------------------------------ *
 * Validation helpers
 * ------------------------------------------------------------------ */

function isValidEmail(email) {
  if (!email || email.length > 254 || email.length < 6) return false;
  if (/[\s<>",;\\]/.test(email)) return false;
  if (email.indexOf('..') !== -1) return false;
  if (!/^[^@]+@[^@]+$/.test(email)) return false;
  const [local, domain] = email.split('@');
  if (!local || local.length > 64) return false;
  if (local.startsWith('.') || local.endsWith('.')) return false;
  if (!/^[a-z0-9.-]+$/.test(domain)) return false;
  if (domain.startsWith('-') || domain.startsWith('.') || domain.endsWith('.') || domain.endsWith('-')) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  if (labels.some(l => l.length === 0 || l.length > 63)) return false;
  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,}$/.test(tld)) return false;
  return true;
}

/** Trim, strip control characters and collapse whitespace, then cap the length.
 *  The newline strip matters: company names end up in an email subject line. */
function clean(value, max) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Like clean(), but for a free-text message where paragraph breaks carry
 *  meaning. Normalises line endings, strips control characters except tab and
 *  newline, collapses runs of blank lines and horizontal spaces, then caps the
 *  length. Newlines survive — that is the whole difference from clean(). */
function cleanMessage(value, max) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \u00A0]{2,}/g, ' ')
    .replace(/ *\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

function num(value, min, max) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

/**
 * Rebuild the audit from its parts. Whatever totals the browser sent are
 * ignored — everything shown in the notification email is derived here from
 * hours, rate and weeks, so the figures in the subject line are always the
 * figures the arithmetic supports.
 *
 * NOTE the same invariant as the front end: every shipped weeks option is
 * even, so per-task costs are always whole numbers and always sum exactly to
 * the total. Keep weeks even if the options ever change.
 */
function normaliseAudit(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

  const rate = num(input.rate, 1, 1000);
  const weeks = num(input.weeks, 1, 53);
  if (rate === null || weeks === null) return null;

  const rawTasks = Array.isArray(input.tasks) ? input.tasks.slice(0, 20) : [];
  const tasks = [];
  for (const t of rawTasks) {
    if (!t || typeof t !== 'object') continue;
    const name = clean(t.name, 60);
    const hrs = num(t.hrs, 0, 168);
    if (!name || hrs === null) continue;
    tasks.push({ name, hrs, cost: Math.round(hrs * rate * weeks) });
  }
  if (!tasks.length) return null;

  tasks.sort((a, b) => {
    const ai = TASK_ORDER.indexOf(a.name);
    const bi = TASK_ORDER.indexOf(b.name);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  const hours = Math.round(tasks.reduce((a, t) => a + t.hrs, 0) * 10) / 10;
  const total = Math.round(hours * rate * weeks);
  const recoverable = Math.round(total * 0.55);

  return { total, recoverable, hours, rate, weeks, tasks };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return []; }
}

/* ------------------------------------------------------------------ *
 * IP handling — hashed for rate limiting, truncated for storage
 * ------------------------------------------------------------------ */

let saltWarned = false;
function warnDefaultSalt() {
  if (!saltWarned) {
    saltWarned = true;
    console.warn('RATE_SALT is not set — using a built-in default. Set the secret: npx wrangler secret put RATE_SALT');
  }
  return 'workings-fallback-salt';
}

async function hashIp(ip, salt) {
  const data = new TextEncoder().encode(salt + '|' + ip);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/** Expand an IPv6 address's "::" elision into its full eight groups.
 *  Returns null for anything that doesn't parse. */
function expandIpv6(ip) {
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1) {
    return head.length === 8 ? head.map(g => g.toLowerCase()) : null;
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return head.concat(Array(missing).fill('0'), tail).map(g => g.toLowerCase());
}

/** What the rate limiter keys on. A single IPv6 customer holds an entire /64,
 *  so keying on the full address would hand them unlimited fresh identities —
 *  key on the /64 prefix instead. IPv4 is keyed as-is. */
function rateKeyFor(ip) {
  if (!ip || !ip.includes(':')) return ip;
  const groups = expandIpv6(ip);
  return groups ? groups.slice(0, 4).join(':') : ip;
}

/** For storage: 81.2.69.142 -> 81.2.69.0 ; 2606:4700::6810:85e5 -> 2606:4700:0::
 *  (the elision is expanded first, so the kept /48 is the real one). */
function truncateIp(ip) {
  if (!ip) return '';
  if (ip.includes(':')) {
    const groups = expandIpv6(ip);
    return groups ? groups.slice(0, 3).join(':') + '::' : '';
  }
  const parts = ip.split('.');
  if (parts.length !== 4) return '';
  parts[3] = '0';
  return parts.join('.');
}

/**
 * Record this attempt and return how many attempts the window now holds,
 * this one included — in a single D1 batch, which runs as one transaction.
 * Doing the insert and the count atomically closes the burst race a separate
 * check-then-record pair would have. The stale-row prune rides along too.
 */
async function recordAndCount(env, ipKey) {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - RATE_WINDOW_SECONDS;
  try {
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO rate_hits (ip_key, ts) VALUES (?1, ?2)`).bind(ipKey, now),
      env.DB.prepare(`DELETE FROM rate_hits WHERE ts < ?1`).bind(cutoff),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM rate_hits WHERE ip_key = ?1 AND ts > ?2`).bind(ipKey, cutoff)
    ]);
    const count = results[results.length - 1];
    const row = count && count.results && count.results[0];
    return row ? Number(row.n) : 1;
  } catch (err) {
    // If the rate-limit table is unreachable, let the request through rather
    // than lose a real lead. Losing a lead is worse than accepting a duplicate.
    console.error('rate limit unavailable', err && err.message);
    return 1;
  }
}

/** Constant-time comparison via fixed-length digests: hashing both sides first
 *  means the loop length and timing are independent of either input. */
async function keysMatch(supplied, actual) {
  if (typeof supplied !== 'string' || typeof actual !== 'string' || !supplied || !actual) {
    return false;
  }
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(supplied)),
    crypto.subtle.digest('SHA-256', enc.encode(actual))
  ]);
  const av = new Uint8Array(a), bv = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

/* ------------------------------------------------------------------ *
 * Email
 * ------------------------------------------------------------------ */

async function notify(env, lead) {
  // Runs inside ctx.waitUntil — a throw here can't reach the user, but it
  // would count as an unhandled rejection, so the whole thing is guarded.
  try {
    if (!env.EMAIL || !env.FROM_EMAIL || !env.NOTIFY_EMAIL) {
      console.warn('email not configured — lead stored but nothing sent');
      return;
    }

    const label = lead.company || lead.email.slice(lead.email.indexOf('@') + 1);
    const headline = lead.audit.total > 0
      ? `£${lead.audit.total.toLocaleString('en-GB')}/yr`
      : 'answered none to everything';

    // replyTo is the whole trick: hitting reply in the notification opens a
    // message straight to the lead, so Graham can answer from his phone
    // without copying an address anywhere.
    await env.EMAIL.send({
      to: env.NOTIFY_EMAIL,
      from: env.FROM_EMAIL,
      replyTo: lead.email,
      subject: clean(`[LEAD] ${label} — ${headline}`, 200),
      text: notificationBody(lead)
    });

    if (lead.leadId != null) {
      try {
        await env.DB.prepare(`UPDATE leads SET notified = 1 WHERE id = ?1`).bind(lead.leadId).run();
      } catch (err) {
        console.error('could not set notified flag', err && err.message);
      }
    }
  } catch (err) {
    // Error objects from the binding carry a code but not the recipient, so
    // this is safe to log. The lead is already saved either way.
    console.error('notification failed', err && (err.code || err.message));
  }
}

/** The contact-form twin of notify(). Same guard, same reply-to trick; the body
 *  is just the message and who sent it. Runs inside ctx.waitUntil. */
async function notifyContact(env, m) {
  try {
    if (!env.EMAIL || !env.FROM_EMAIL || !env.NOTIFY_EMAIL) {
      console.warn('email not configured — message stored but nothing sent');
      return;
    }

    const label = m.name || m.email.slice(m.email.indexOf('@') + 1);
    const when = new Date(m.createdAt).toLocaleString('en-GB', {
      timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

    const lines = [];
    lines.push(m.name ? `${m.name}` : '(no name given)');
    lines.push(`${m.email}`);
    lines.push(`${when} · ${m.source}`);
    lines.push('');
    lines.push('MESSAGE');
    lines.push(m.message);
    lines.push('');
    lines.push('---');
    lines.push('Reply to this email and it goes straight to them.');
    lines.push(`Submitted from ${m.ipTrunc || 'unknown'} (truncated).`);

    await env.EMAIL.send({
      to: env.NOTIFY_EMAIL,
      from: env.FROM_EMAIL,
      replyTo: m.email,
      subject: clean(`[CONTACT] ${label}`, 200),
      text: lines.join('\n')
    });

    if (m.msgId != null) {
      try {
        await env.DB.prepare(`UPDATE messages SET notified = 1 WHERE id = ?1`).bind(m.msgId).run();
      } catch (err) {
        console.error('could not set notified flag (message)', err && err.message);
      }
    }
  } catch (err) {
    console.error('contact notification failed', err && (err.code || err.message));
  }
}

function pad(s, width) {
  s = String(s);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function gbp(n) {
  return '£' + Number(n).toLocaleString('en-GB');
}

/** Everything Graham needs to write a good reply from his phone, and nothing else. */
function notificationBody(lead) {
  const a = lead.audit;
  const when = new Date(lead.createdAt).toLocaleString('en-GB', {
    timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });

  const ranked = a.tasks.slice().filter(t => t.hrs > 0).sort((x, y) => y.cost - x.cost);

  const lines = [];
  lines.push(`${lead.company || '(no company given)'}`);
  lines.push(`${lead.email}`);
  lines.push(`${when} · ${lead.source}`);
  lines.push('');
  lines.push('THE NUMBER');
  lines.push(`  ${pad('Annual cost of manual admin', 32)} ${gbp(a.total)}`);
  lines.push(`  ${pad('Recoverable at 55%', 32)} ${gbp(a.recoverable)}`);
  lines.push('');
  lines.push('INPUTS');
  lines.push(`  ${pad('Hours a week', 32)} ${a.hours}`);
  lines.push(`  ${pad('Loaded hourly cost', 32)} ${gbp(a.rate)}`);
  lines.push(`  ${pad('Trading weeks a year', 32)} ${a.weeks}`);
  lines.push('');

  if (ranked.length) {
    lines.push('WHERE IT GOES (ranked by cost)');
    ranked.forEach((t, i) => {
      lines.push(`  ${i + 1}. ${pad(t.name, 28)} ${pad(t.hrs + ' hrs/wk', 12)} ${gbp(t.cost)}/yr`);
    });
  } else {
    lines.push('WHERE IT GOES');
    lines.push('  Nothing. They answered "none" to all six — worth asking why they');
    lines.push('  bothered running it. Usually means they are underestimating.');
  }

  const zeros = a.tasks.filter(t => t.hrs === 0).map(t => t.name);
  if (zeros.length && ranked.length) {
    lines.push('');
    lines.push(`  Said "none" to: ${zeros.join(', ')}`);
  }

  lines.push('');
  lines.push('---');
  lines.push('Reply to this email and it goes straight to them.');
  lines.push(`Submitted from ${lead.ipTrunc || 'unknown'} (truncated).`);

  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * HTTP plumbing
 * ------------------------------------------------------------------ */

/** The configured origin plus its www / bare-domain twin, so the site works
 *  identically whichever of the two the domain is served from. */
function allowedOrigins(env) {
  const configured = (env.ALLOWED_ORIGIN || '').replace(/\/+$/, '');
  if (!configured) return [];
  const m = configured.match(/^(https?:\/\/)(www\.)?(.+)$/);
  if (!m) return [configured];
  return [m[1] + m[3], m[1] + 'www.' + m[3]];
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const headers = { 'Vary': 'Origin' };
  if (origin && allowedOrigins(env).includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'POST, GET, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Admin-Key';
    headers['Access-Control-Max-Age'] = '86400';
  }
  return headers;
}

function preflight(request, env) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

function json(payload, status, request, env) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...corsHeaders(request, env)
    }
  });
}
