# Workings

A one-page site with a self-serve waste audit and lead capture. Cloudflare Pages for the
site, a Cloudflare Worker plus D1 for submissions. No build step, no framework, no
`node_modules`. Everything is a file you can open in a text editor.

```
index.html          the entire site
privacy.html        UK GDPR privacy notice
terms.html          terms of use
thanks.html         where the form lands. Not indexed, not in the sitemap.
admin.html          leads list. Not linked, not indexed. Needs the admin key.
robots.txt
sitemap.xml
favicon.svg
apple-touch-icon.png
og.png              1200×630 social share card
fonts/              self-hosted latin subsets — no Google Fonts request
_headers            security headers for Cloudflare Pages
setup.sh            swaps the placeholders for your real details
reply-template.md   how to answer a submission
worker/
  src/index.js      lead capture Worker
  wrangler.toml
  schema.sql        D1 tables
```

The fonts are served from this repo rather than from Google. That keeps first paint fast
on a bad connection, means the audit tool can't be delayed by a third-party outage, and
means the privacy notice can say the page does not involve a font service.

---

## Decisions taken

| # | Decision | Answer |
|---|---|---|
| D1 | Trading name | **Workings** |
| D2 | Domain | **theworkings.uk** — bought, zone live in Cloudflare |
| D3 | Business email | `graham@theworkings.uk` — needs Cloudflare Email Routing to receive (see launch steps) |
| D4 | Limited company | **Trades under Loaded Dice Ltd** (company no. 12429789, VAT GB 342132248) — footer, privacy and terms all carry the full details |
| D5 | Prices | As placeholdered — free call / £1,200 audit / from £3,500 build / £750pm |
| D6 | Audit refund guarantee | **Cut.** Not published anywhere |
| D7 | Claim register | C1, C2, C3 confirmed and published. C7 cut |
| D8 | Calendar | Cal.com — live. `graham-u7vhke/a-look-at-your-workings`, 45 minutes, free. The username deliberately carries no surname |

There are **no `CHECK` comments left in the source**. Everything on the page is either
confirmed or labelled illustrative.

### Things still open

1. **A better photograph, someday.** The operator card now carries a real photo of
   Graham (`graham.jpg` — seafront, arms folded). The brief's ideal is still a shot at
   the shop or the warehouse; when one exists, process it the same way (crop 4:3,
   ~960px wide, metadata stripped) and replace the file. Nothing else needs touching.

---

## Getting it live

### 1. Fill in your details

```bash
./setup.sh yourdomain.co.uk you@yourdomain.co.uk https://cal.com/you/look-45min
git diff && git commit -am "Real details"
```

### 2. Pages

Connect this repo in the Cloudflare dashboard → Workers & Pages → Create → Pages → Connect
to Git. There is no build command and no output directory — it's static. Add the custom
domain, HTTPS is automatic. `_headers` is picked up on deploy.

Analytics is **Google Analytics 4**, property `G-294TV3LSGP`, and the tag is already in
the head of `index.html`, `privacy.html`, `terms.html` and `thanks.html` — four copies, so
changing the measurement ID means four edits. `admin.html` is deliberately untagged.

It runs with **Consent Mode denied by default**, which is the whole reason there is still
no cookie banner: with `analytics_storage` denied GA4 sets no cookies and stores nothing on
the visitor's device, so there is nothing to ask permission for. You get page views,
sessions and traffic sources; you don't get returning-visitor identity. Read the comment
block above the tag in `index.html` before changing any of it — the ordering of those
`gtag()` calls is load-bearing, and getting it wrong means cookies start being set without
consent.

The CSP in `_headers` has to allow the Google origins or the tag is blocked outright and
reports nothing, with no error anywhere except the browser console. If analytics ever goes
quiet, check there first.

While you're in the dashboard, add a **WAF rate-limiting rule** on `/api/lead`
(Security → WAF → Rate limiting rules; the free plan includes one). The Worker
has its own limiter, but the WAF rule runs at the edge before the Worker, so a
flood costs you nothing in Worker invocations or database reads. Five minutes,
no code.

### 3. Worker and database

```bash
cd worker
# the database already exists and its id is in wrangler.toml
npx wrangler secret put NOTIFY_EMAIL           # where [LEAD] emails land
npx wrangler secret put FROM_EMAIL             # graham@theworkings.uk
npx wrangler secret put ADMIN_KEY              # openssl rand -hex 32
npx wrangler secret put RATE_SALT              # openssl rand -hex 32

npx wrangler deploy
```

The routes in `wrangler.toml` put the Worker on `yourdomain.co.uk/api/*`, on the same
domain as the site. That is deliberate: `fetch('/api/lead')` stays same-origin, so there
is no CORS preflight to pay for. `ALLOWED_ORIGIN` is still set, so the endpoint stays
locked to your domain if anything ever calls it cross-origin.

**Email is pure Cloudflare — no third-party mail provider.** The Worker sends through the
Email Routing `send_email` binding, which is free on any plan but can only reach addresses
**verified as Email Routing destinations**. So before deploying: Cloudflare dashboard →
theworkings.uk → Email → Email Routing, enable it, add your real inbox as a destination and
click the confirmation link. `NOTIFY_EMAIL` must be that exact verified address, and
`FROM_EMAIL` an address on this domain.

That constraint is also why there is **no automatic acknowledgement to the person who
submits** — Cloudflare cannot send to arbitrary strangers, and paying for a mail provider
to send "we got your form" would contradict the whole promise. The page already tells them
Graham will reply personally, and his reply is the acknowledgement. Hitting reply on the
`[LEAD]` email opens a message straight to them.

If a lead ever arrives while email is broken, the row is still saved and `admin.html` flags
it as "email not sent".

### 4. Check it works

```bash
# should return {"ok":true} and put a row in D1
curl -s https://yourdomain.co.uk/api/lead \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@yourdomain.co.uk","company":"Test Ltd","elapsed":9000,
       "source":"manual-test",
       "audit":{"rate":22,"weeks":46,"tasks":[{"name":"Data re-entry","hrs":7}]}}'

# should return 400
curl -s -o /dev/null -w '%{http_code}\n' https://yourdomain.co.uk/api/lead \
  -H 'Content-Type: application/json' -d '{"email":"nope"}'

# every attempt counts toward the 5/hour limit — including the two tests
# above — so this loop flips from 400 to 429 partway through. If you see
# any 429 by the end, rate limiting works.
for i in 1 2 3 4 5 6 7 8; do
  curl -s -o /dev/null -w "$i: %{http_code}\n" https://yourdomain.co.uk/api/lead \
    -H 'Content-Type: application/json' -d '{"email":"x"}'
done
```

Two things about testing that will save you an hour of confusion:

- **The form only works end-to-end on the custom domain.** The Worker route is
  bound to your zone, so on the `*.pages.dev` preview URL `fetch('/api/lead')`
  hits Pages, not the Worker, and fails. That is expected, not broken.
- The rate limit means your own testing can lock you out for an hour. Test the
  happy path last, or from a different network.

Then run it properly from a phone: answer all eight, check the number appears **before**
the form, submit, and confirm the `[LEAD]` email lands.

---

## Reading your leads

**A note on names.** The Worker is named `agency` — Cloudflare's "Import a
repository" flow names Workers after the repo, and renaming one means deleting
it and re-entering every secret, so it stays. The D1 database is `workings-leads`.
Different things, similar names.

Open `https://yourdomain.co.uk/admin`, paste the `ADMIN_KEY`. The page is kept out of
search by a `noindex` meta tag and an `X-Robots-Tag` header (deliberately *not* by
robots.txt, which would advertise the path), it isn't linked from anywhere, and the key
lives in memory only — refresh and you type it again. Nothing on this site writes to
browser storage.

Or from the command line:

```bash
cd worker
npx wrangler d1 execute workings-leads --remote --command \
  "SELECT created_at, company, email, total, recoverable, notified FROM leads ORDER BY id DESC LIMIT 20"
```

A deletion request (someone exercising their UK GDPR right to erasure):

```bash
npx wrangler d1 execute workings-leads --remote --command \
  "DELETE FROM leads WHERE email = 'them@example.co.uk'"
```

The privacy notice promises submissions are deleted after 24 months. The Worker enforces
that itself: a daily cron (see `[triggers]` in `wrangler.toml`) deletes anything older
and sweeps stale rate-limit rows. Nothing for you to remember.

---

## Measurement

The four numbers worth watching weekly, in order:

| Step | Where it comes from |
|---|---|
| Page views | Google Analytics 4 |
| Audit started | first `select` change — see the note below |
| Calculated | click on "Calculate my number" |
| Email submitted | `SELECT COUNT(*) FROM leads WHERE created_at > date('now','-7 days')` |

Steps 1 and 4 work today with no extra code. Steps 2 and 3 are now cheap to add — GA4 is
already on the page, so each is one line at the right moment:

```js
gtag('event','audit_started');     // in the first select's change handler
gtag('event','audit_calculated');  // in the Calculate my number handler
```

These still set no cookies: `gtag('event', …)` respects the denied consent default and
sends a cookieless ping like everything else. I have deliberately **not** added them,
because two events you never look at are worse than no events, and the middle of a funnel
only matters once you know it is leaking. Add them the first week you see views going up
and submissions staying flat — not before.

---

## Editing the site later

It's one file. Open `index.html`, change the words, save, push. Cloudflare rebuilds in
about twenty seconds. Things worth knowing:

- **The form lands on `/thanks`.** The submit handler POSTs to the Worker and then
  redirects on success, so the thank-you page is the signal that a lead actually
  arrived — which is why it carries a `generate_lead` event and why `_headers`
  keeps it out of search. Nothing is passed in the URL: putting the annual figure
  in a query string would leak it into analytics paths and referrer headers, and
  it is the one number on this site that belongs to the visitor.
- **The audit questions** are the `QUESTIONS` array near the bottom of `index.html`. Adding
  a seventh task question means adding one entry with a `key` — the maths and the ranked
  list pick it up on their own. The Worker validates against `TASK_ORDER` in
  `worker/src/index.js`; add the new label there too or it will still work, it'll just sort
  to the bottom of the notification email.
- **The 55% figure** appears in three places: the on-screen workings, `terms.html`, and
  `normaliseAudit()` in the Worker. Change all three or the email won't match the page.
- **Colours** are the CSS variables at the top, and each one is allowed to mean exactly one
  thing. Red is money leaking. Green is money recovered. `--hi`, the highlighter yellow, is
  "this is the bit that matters" — and only ever a background with ink on top, never text,
  because it is far too bright to read. `--drab` is the old palette this site used to wear,
  kept alive solely for the spreadsheet exhibit in the hero, so that the old way of working
  literally looks older than the page around it. Don't use any of them as decoration; the
  whole design argument falls over if they become pattern.
- **Don't add** a cookie banner, a chat widget or a pop-up. There are still no cookies —
  analytics runs with storage consent denied — so there is nothing to consent to, and that
  is a feature worth protecting. If you ever grant `analytics_storage`, the banner becomes
  compulsory the same day, and the privacy notice needs rewriting with it.

---

## Things I'd consider later, and why they're not here

- **Cloudflare's native rate-limiting binding** instead of the `rate_hits` table. Cleaner,
  but it's one more binding to configure and the table works. (The WAF rule above is the
  higher-value version of the same idea.)
- **Funnel events** — see above. Deliberately deferred.
- **A PDF of the audit.** Explicitly out of scope, and it should stay that way. The reply
  is the product; a PDF is a thing you'd then have to keep maintaining.
