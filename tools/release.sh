#!/bin/sh
# release.sh [<owner>/<repo>] - `make release`: build, bump the patch of every component that changed, test, commit,
# push, and publish the Store's `catalog` release (docs/INSTALL.md). The owner's rules (2026-11-27): the catalog
# layout, patch versions bumped automatically, nothing secret ever leaves this computer.
#
#   1. refuses unless on main, with a clean tree, level with origin/main: what is published is what is committed;
#   2. make dist, and the published catalog.json (none before the first release);
#   3. tools/release.js plan: a component whose new package differs from the published one at the same version
#      gets the next patch (builds are byte-identical, so "differs" means "changed"); applied, rebuilt, planned
#      again until nothing more changes (a new service version changes the app's requirement, so the app follows);
#   4. nothing changed since the published release: stops, nothing is published;
#   5. a bump: make test, then a commit "Release ..." (pre-commit scan) and a push (pre-push scan);
#   6. tools/publish-catalog.sh, which scans exactly what it uploads before uploading.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
REPO=${1:-$(git remote get-url origin | sed -E 's#^(https://github.com/|git@github.com:)##; s#\.git$##')}
NODE="docker run --rm -v $ROOT:/w -w /w node:22-slim node"
OUT=dist/idrive7-tidal

[ "$(git branch --show-current)" = main ] || { echo "release: switch to main first" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "release: commit or remove the changes first (git status)" >&2; exit 1; }
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "release: main is not level with origin/main" >&2; exit 1; }

PUB=build/published-catalog.json
rm -f "$PUB"; mkdir -p build
if gh release view catalog -R "$REPO" >/dev/null 2>&1; then
    gh release download catalog -R "$REPO" -p catalog.json -O "$PUB" --clobber
    echo "release: published now: $($NODE -e "const c=require('/w/$PUB');console.log(c.components.map(x=>x.id+' '+x.version).join(', '))")"
else
    echo "release: nothing published yet: this is the first release"
fi
PUBARG=$([ -f "$PUB" ] && echo "$PUB" || echo none)

make dist
bumped=0
i=0
while :; do
    plan=$($NODE tools/release.js plan "$OUT/catalog.json" "$PUBARG")
    [ "$plan" = "[]" ] && break
    i=$((i + 1)); [ "$i" -le 3 ] || { echo "release: the versions do not settle after 3 rounds: $plan" >&2; exit 1; }
    $NODE tools/release.js apply "$plan"
    bumped=1
    make dist
done

if [ -f "$PUB" ] && [ "$bumped" = 0 ]; then
    same=$($NODE -e "
        const a=require('/w/$OUT/catalog.json').components, b=require('/w/$PUB').components;
        const k=(l)=>l.map(c=>c.id+'@'+c.version+':'+c.artifact.sha256).sort().join(' ');
        console.log(k(a)===k(b)?'yes':'no')")
    [ "$same" = yes ] && { echo "release: nothing changed since the published release: nothing to publish"; exit 0; }
fi

if [ "$bumped" = 1 ]; then
    make test
    v=$($NODE tools/release.js versions)
    git add native/cmocan-tidal/component.json native/cmocan-tidal/service.js apps/cmocan_tidal/app.json
    git commit -q -m "Release: $v

Patch versions bumped by make release for the components whose packages changed.

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
    git push -q origin main
fi

sh tools/publish-catalog.sh "$REPO"
echo "release: done: $($NODE tools/release.js versions)"
