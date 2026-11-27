#!/bin/sh
# publish-catalog.sh <owner>/<repo> - puts dist/idrive7-tidal (make dist) on the repository's GitHub release `catalog`,
# which the car's Store reads when the repository is added on "Releases" (docs/INSTALL.md).
#
# The owner runs it on the Mac, with the GitHub CLI signed in to an account that may write the repository's releases
# (`gh auth status`); the car's read-only token is another one. Steps:
#   1. the release `catalog` is made when it is not there (not the latest release, never a draft);
#   2. the tool kit, the app package and the icon are uploaded (an older copy of the same name is replaced);
#   3. catalog.json is written for the release: the same as dist's, each artifact at its asset's API address,
#      which the head unit downloads with its token from a private repository (tools/dist_catalog.js release),
#      and uploaded last, so the Store never lists an artifact that is not there yet;
#   4. assets catalog.json no longer names are removed.
# Nothing else on GitHub changes. Only a higher version is an update for the car: raise the version in
# native/cmocan-tidal/component.json (and service.js) or apps/cmocan_tidal/app.json before `make dist`.
set -eu
REPO=${1:-}
case "$REPO" in */*) ;; *) echo "usage: sh tools/publish-catalog.sh <owner>/<repo>" >&2; exit 2 ;; esac
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
OUT=dist/idrive7-tidal
WORK=build/catalog-release
[ -f "$OUT/catalog.json" ] || { echo "no $OUT/catalog.json: run make dist first" >&2; exit 1; }
command -v gh >/dev/null || { echo "the GitHub CLI (gh) is needed" >&2; exit 1; }
rm -rf "$WORK" && mkdir -p "$WORK"

if ! gh release view catalog -R "$REPO" >/dev/null 2>&1; then
    gh release create catalog -R "$REPO" --title "Store catalog" --latest=false \
        --notes "The car's Store reads this release (catalog.json): the TIDAL service and app. Made by tools/publish-catalog.sh."
fi
gh release upload catalog -R "$REPO" --clobber "$OUT"/*.tgz "$OUT"/*.png
gh api "repos/$REPO/releases/tags/catalog" > "$WORK/release.json"
docker run --rm -v "$ROOT:/w" -w /w node:22-slim \
    node tools/dist_catalog.js release "$OUT/catalog.json" "$WORK/release.json" "$WORK/catalog.json"
gh release upload catalog -R "$REPO" --clobber "$WORK/catalog.json"

keep=$(cd "$OUT" && ls ./*.tgz ./*.png | sed 's#^\./##'; echo catalog.json)
gh release view catalog -R "$REPO" --json assets --jq '.assets[].name' | while read -r a; do
    echo "$keep" | grep -qxF "$a" || { echo "removing the old asset $a"; gh release delete-asset catalog "$a" -R "$REPO" --yes; }
done
echo "the release catalog of $REPO now holds:"
gh release view catalog -R "$REPO" --json assets --jq '.assets[] | "  \(.size)  \(.name)"'
