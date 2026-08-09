#!/usr/bin/env bash
#
# Swaps the four placeholders for your real details, everywhere at once.
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

for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || continue
  # Order matters: replace the email before the bare domain, or the domain
  # substitution would eat the address's domain part first.
  perl -pi -e "s/\Qgraham\@workings.co.uk\E/${EMAIL//\//\\/}/g" "$f"
  perl -pi -e "s|\Qhttps://cal.com/workings/look-45min\E|${CALENDAR//|/\\|}|g" "$f"
  perl -pi -e "s/\Qworkings.co.uk\E/${DOMAIN//\//\\/}/g" "$f"
  echo "updated $f"
done

echo
echo "Done. Now:"
echo "  1. grep -rn 'SOLE TRADER / COMPANY DETAILS' .   and fill those in"
echo "  2. git diff   and read it"
echo "  3. git commit"
