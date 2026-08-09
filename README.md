# Workings

A one-page site with a self-serve waste audit and lead capture. Cloudflare Pages for the
site, a Cloudflare Worker plus D1 for submissions. No build step, no framework, no
`node_modules`. Everything is a file you can open in a text editor.

```
index.html          the entire site
privacy.html        UK GDPR privacy notice
terms.html          terms of use
admin.html          leads list. Not linked, not indexed. Needs the admin key.
robots.txt
sitemap.xml
favicon.svg
og.png              1200×630 social share card
_headers            security headers for Cloudflare Pages
setup.sh            swaps the four placeholders for your real details
reply-template.md   how to answer a submission
worker/
  src/index.js      lead capture Worker
  wrangler.toml
  schema.sql        D1 tables
```

---

## Decisions taken

| # | Decision | Answer |
|---|---|---|
| D1 | Trading name | **Workings** |
| D2 | Domain | Not bought yet — placeholder `workings.co.uk` throughout, swapped by `setup.sh` |
| D3 | Business email | Not set yet — placeholder `graham@workings.co.uk`, same |
| D4 | Limited company | Default: launch as sole trader, register later. Footer reads `[SOLE TRADER / COMPANY DETAILS]` until you fill it in |
| D5 | Prices | As placeholdered — free call / £1,200 audit / from £3,500 build / £750pm |
| D6 | Audit refund guarantee | **Cut.** Not published anywhere |
| D7 | Claim register | C1, C2, C3 confirmed and published. C7 cut |
| D8 | Calendar | Cal.com. Placeholder link `https://cal.com/workings/look-45min` |

There are **no `CHECK` comments left in the source**. Everything on the page is either
confirmed or labelled illustrative.

### Two things still open

1. **"+ VAT" on the prices vs sole trader status.** The pricing panels say "+ VAT". If you
   launch as an unregistered sole trader you can't charge it, and saying you will is a
   problem. Either register, or delete the three "+ VAT" strings in `index.html` and the
   line about VAT in `terms.html`. Five seconds either way, but do it before you launch.
2. **The footer legal line.** `[SOLE TRADER / COMPANY DETAILS]` appears in `index.html`,
   `privacy.html` and `terms.html`. A sole trader trading under a name other than their own
   must show their own name and an address for service — "Workings — Graham Surname, Barry,
   South Wales" does it.

---

## Getting it live

### 1. Fill in your details

```bash
./setup.sh yourdomain.co.uk you@yourdomain.co.uk https://cal.com/you/look-45min
grep -rn 'SOLE TRADER / COMPANY DETAILS' .     # then fill those in by hand
git diff && git commit -am "Real details"
```

### 2. Pages

Connect this repo in the Cloudflare dashboard → Workers & Pages → Create → Pages → Connect
to Git. There is no build command and no output directory — it's static. Add the custom
domain, HTTPS is automatic. `_headers` is picked up on deploy.

Turn on **Web Analytics** (Cloudflare dashboard → Analytics → Web Analytics → add the site).
Use the automatic setup so Cloudflare injects the beacon — no cookies, so no consent banner.
The CSP in `_headers` already allows `static.cloudflareinsights.com`. Do this before
launch: the privacy notice mentions it, so it should be true on day one.

While you're in the dashboard, add a **WAF rate-limiting rule** on `/api/lead`
(Security → WAF → Rate limiting rules; the free plan includes one). The Worker
has its own limiter, but the WAF rule runs at the edge before the Worker, so a
flood costs you nothing in Worker invocations or database reads. Five minutes,
no code.

### 3. Worker and database

```bash
cd worker
npx wrangler d1 create workings-leads          # paste the id into wrangler.toml
npx wrangler d1 execute workings-leads --remote --file=./schema.sql

npx wrangler secret put NOTIFY_EMAIL           # where [LEAD] emails land
npx wrangler secret put FROM_EMAIL             # your verified sending address
npx wrangler secret put RESEND_API_KEY         # resend.com, free tier
npx wrangler secret put ADMIN_KEY              # openssl rand -hex 32
npx wrangler secret put RATE_SALT              # openssl rand -hex 32

npx wrangler deploy
```

The routes in `wrangler.toml` put the Worker on `yourdomain.co.uk/api/*`, on the same
domain as the site. That is deliberate: `fetch('/api/lead')` stays same-origin, so there
is no CORS preflight to pay for. `ALLOWED_ORIGIN` is still set, so the endpoint stays
locked to your domain if anything ever calls it cross-origin.

**Resend needs the sending domain verified** (three DNS records: SPF, DKIM, DMARC). Do that
before the first real submission or the acknowledgement silently won't send. The lead is
still saved either way — `admin.html` flags any row where the notification didn't go out.

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
the form, submit, and confirm both emails land.

---

## Reading your leads

Open `https://yourdomain.co.uk/admin.html`, paste the `ADMIN_KEY`. It's `noindex`,
`Disallow`ed in robots.txt, not linked from anywhere, and the key lives in memory only —
refresh and you type it again. Nothing on this site writes to browser storage.

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
that itself: a weekly cron (see `[triggers]` in `wrangler.toml`) deletes anything older
and sweeps stale rate-limit rows. Nothing for you to remember.

---

## Measurement

The four numbers worth watching weekly, in order:

| Step | Where it comes from |
|---|---|
| Page views | Cloudflare Web Analytics |
| Audit started | first `select` change — see the note below |
| Calculated | click on "Calculate my number" |
| Email submitted | `SELECT COUNT(*) FROM leads WHERE created_at > date('now','-7 days')` |

Steps 1 and 4 work today with no extra code. Steps 2 and 3 need three lines of event
tracking, and I have deliberately **not** added them, because the only free way to do it
without cookies is another `POST` to the Worker on every interaction — which means another
table, another thing writing rows, and another thing to prune. Given you can already see
views in and submissions out, the middle two only matter once the funnel is leaking and you
don't know where. Add them then, not now.

---

## Editing the site later

It's one file. Open `index.html`, change the words, save, push. Cloudflare rebuilds in
about twenty seconds. Things worth knowing:

- **The audit questions** are the `QUESTIONS` array near the bottom of `index.html`. Adding
  a seventh task question means adding one entry with a `key` — the maths and the ranked
  list pick it up on their own. The Worker validates against `TASK_ORDER` in
  `worker/src/index.js`; add the new label there too or it will still work, it'll just sort
  to the bottom of the notification email.
- **The 55% figure** appears in three places: the on-screen workings, `terms.html`, and
  `normaliseAudit()` in the Worker. Change all three or the email won't match the page.
- **Colours** are the CSS variables at the top. Red only ever means money leaking, green
  only ever means money recovered. Don't use either as an accent — the whole design argument
  falls over if they become decoration.
- **Don't add** a cookie banner, a chat widget or a pop-up. There are no cookies, so there
  is nothing to consent to, and that is a feature worth protecting.

---

## Things I'd consider later, and why they're not here

- **Self-hosting the three fonts.** Would drop the request to `fonts.gstatic.com`, shave a
  round trip off first paint, and let the privacy notice say "no third parties" flat out.
  Costs about 250KB in the repo and one more thing to understand. Worth doing if the
  Lighthouse performance score ever dips below 95 on a real phone.
- **Cloudflare's native rate-limiting binding** instead of the `rate_hits` table. Cleaner,
  but it's one more binding to configure and the table works.
- **Funnel events** — see above. Deliberately deferred.
- **A PDF of the audit.** Explicitly out of scope, and it should stay that way. The reply
  is the product; a PDF is a thing you'd then have to keep maintaining.
