#!/usr/bin/env bash
#
# Swaps the placeholder domain, email and calendar link for your real details,
# everywhere at once.
#
#   ./setup.sh workings.co.uk graham@workings.co.uk https://cal.com/you/look-45min
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

  domain        no https://, no trailing slash   e.g. workings.co.uk
  email         your business address            e.g. graham@workings.co.uk
  calendar-url  full Cal.com link                e.g. https://cal.com/you/look-45min

Still to do by hand afterwards (there is no sensible default for these):
  * "[SOLE TRADER / COMPANY DETAILS]" in the footer of index.html,
    privacy.html and terms.html
  * database_id in worker/wrangler.toml, after `wrangler d1 create`
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
    s/graham\@workings\.co\.uk/$ENV{NEW_EMAIL}/g;
    s{\Qhttps://cal.com/workings/look-45min\E}{$ENV{NEW_CAL}}g;
    s/\Qworkings.co.uk\E/$ENV{NEW_DOMAIN}/g;
  ' "$f"
  echo "updated $f"
done

# A silent half-swap is worse than a loud failure — refuse to report success
# if any placeholder survived. (Skipped if the real domain IS workings.co.uk,
# where the check couldn't tell success from failure.)
if [[ "$DOMAIN" != *workings.co.uk* ]] && grep -rqF 'workings.co.uk' index.html privacy.html terms.html robots.txt sitemap.xml worker/wrangler.toml; then
  echo >&2
  echo "Something did not get replaced — these placeholders survived:" >&2
  grep -rnF 'workings.co.uk' index.html privacy.html terms.html robots.txt sitemap.xml worker/wrangler.toml >&2 | head -10
  exit 1
fi

echo
echo "Done. Now:"
echo "  1. grep -rn 'SOLE TRADER / COMPANY DETAILS' .   and fill those in"
echo "  2. git diff   and read it"
echo "  3. git commit"
