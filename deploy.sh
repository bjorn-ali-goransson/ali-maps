#!/usr/bin/env bash
# Publish the site: stamp every page with a fresh asset version, commit, and
# write `version.json` naming that commit, which open pages poll to know when
# to reload themselves (see "live updates" in app.js).
#
#   ./deploy.sh "Commit message"      then push HEAD to gh-pages
set -euo pipefail
cd "$(dirname "$0")"

# `layers.js` is imported by app.js, so it carries its own version there.
LV=$(sha1sum layers.js | cut -c1-10)
sed -i "s#\./layers\.js?v=[0-9a-f]*#./layers.js?v=$LV#" app.js

# One version for the whole build: any asset changing changes it.
V=$(cat app.js style.css layers.js alimap.js engine/*.js ./*.worker.js \
    | sha1sum | cut -c1-10)
OLD=$(grep -o 'app\.js?v=[0-9a-f]*' index.html | head -1 | cut -d= -f2)
if [ "$OLD" != "$V" ]; then
  grep -rl --include='*.html' -e "?v=$OLD" . | xargs sed -i "s/?v=$OLD/?v=$V/g"
fi

git add -A
git diff --cached --quiet || git commit -q -m "${1:-Publish}"

C=$(git rev-parse HEAD)
printf '{"v": "%s", "commit": "%s"}\n' "$V" "$C" > version.json
git add version.json
git diff --cached --quiet || git commit -q -m "Stamp version.json: build $V from ${C:0:7}"
echo "build $V · commit ${C:0:7}"
