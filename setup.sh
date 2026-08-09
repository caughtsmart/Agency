#!/usr/bin/env bash
#
# Swaps the placeholder domain, email and calendar link for your real details,
# everywhere at once.
#
#   ./setup.sh theworkings.uk graham@theworkings.uk https://cal.com/you/look-45min
#
# Run it once, check `git diff`, commit. If you get it wrong, `git checkout .`
# and run it again. It refuses to run on a dirty working tree for that reason.

set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
CALENDAR="${3:-}"

if [[ -z "$DOMAIN" || -z "$EMAIL" || -z "$CALENDAR" ]]; then
  cat <<'USAGE'
Usage: ./setup.sh <domain> <email> <calendar-url>

  domain        no https://, no trailing slash   e.g. theworkings.uk
  email         your business address            e.g. graham@theworkings.uk
  calendar-url  full Cal.com link                e.g. https://cal.com/you/look-45min

The legal details (Loaded Dice Ltd, company no., VAT no.) are already in the
footer of index.html, privacy.html and terms.html — edit those by hand if the
company ever changes.
USAGE
  exit 1
fi

cd "$(dirname "$0")"

if [[ -d .git ]] && ! git diff --quiet 2>/dev/null; then
  echo "Working tree has uncommitted changes. Commit or stash first so you can undo this." >&2
  exit 1
fi

FILES=(index.html privacy.html terms.html robots.txt sitemap.xml worker/wrangler.toml README.md)

# The values travel to Perl through the environment, never through the pattern
# or replacement text — so an email's @, a URL's ?/&/$, or any other character
# can't be misread by the shell or by Perl's string interpolation.
# Order matters: the email is replaced before the bare domain, or the domain
# substitution would eat the address's domain half first.
for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || continue
  NEW_DOMAIN="$DOMAIN" NEW_EMAIL="$EMAIL" NEW_CAL="$CALENDAR" perl -pi -e '
    s/graham\@theworkings\.uk/$ENV{NEW_EMAIL}/g;
    s{\Qhttps://cal.com/workings/look-45min\E}{$ENV{NEW_CAL}}g;
    s/\Qtheworkings.uk\E/$ENV{NEW_DOMAIN}/g;
  ' "$f"
  echo "updated $f"
done

# A silent half-swap is worse than a loud failure — refuse to report success
# if any placeholder survived. (Skipped if the real domain IS theworkings.uk,
# where the check couldn't tell success from failure.)
if [[ "$DOMAIN" != *theworkings.uk* ]] && grep -rqF 'theworkings.uk' index.html privacy.html terms.html robots.txt sitemap.xml worker/wrangler.toml; then
  echo >&2
  echo "Something did not get replaced — these placeholders survived:" >&2
  grep -rnF 'theworkings.uk' index.html privacy.html terms.html robots.txt sitemap.xml worker/wrangler.toml >&2 | head -10
  exit 1
fi

echo
echo "Done. Now:"
echo "  1. git diff   and read it"
echo "  2. git commit"
