#!/bin/sh
# dist.sh [usb <stick folder>] - the install packages (task I2, docs/INSTALL.md). Everything runs in Docker.
#
#   sh tools/dist.sh              dist/idrive7-tidal/: catalog.json, cmocan-tidal@<v>.tgz (the tool kit, packed by
#                                 mgu-store's deploy/hu artifact), cmocan_tidal@<v>.tgz (the app, tools/dist_app.py)
#                                 and cmocan_tidal.png; then the checks: check-target on the player inside the kit,
#                                 a kingfisher scan of everything unpacked, mgu-store's own usb-repo on a scratch
#                                 stick, tests/dist.test.js on both Node versions
#   sh tools/dist.sh usb <stick> [github:<owner>/<repo>]
#                                 that folder (or the repository's published catalog release) onto a USB stick,
#                                 with mgu-store's mgu-install.js usb-repo
#
# The player must be built first (`make player`; `make dist` does it). mgu-store comes from MGU_STORE (a checkout),
# by default build/mgu-store, cloned from MGU_STORE_GIT at the commit MGU_STORE_REV: only its deploy/hu,
# tools/oap_pack.js and deploy/mgu-install.js are run, inside Docker.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
OUT=dist/idrive7-tidal
CHECK=build/dist-check
MGU_STORE=${MGU_STORE:-build/mgu-store}
MGU_STORE_GIT=${MGU_STORE_GIT:-https://github.com/robertnisipeanu/mgu-store.git}
MGU_STORE_REV=${MGU_STORE_REV:-37702a880f1ed5fd346f4c944127fb276920be9c}
KIT_IMAGE=${KIT_IMAGE:-cmocan-tidal-kit}

case "$MGU_STORE" in /*) ;; *) MGU_STORE="$ROOT/$MGU_STORE" ;; esac
# mgu-store is mounted read-only at /mgu-store in the containers
STORE_IN=/mgu-store

mgu_store() {
    if [ ! -e "$MGU_STORE/.git" ]; then
        echo "mgu-store: cloning $MGU_STORE_GIT into $MGU_STORE"
        git clone -q --no-checkout "$MGU_STORE_GIT" "$MGU_STORE"
    fi
    git -C "$MGU_STORE" cat-file -e "$MGU_STORE_REV^{commit}" 2>/dev/null || git -C "$MGU_STORE" fetch -q origin
    # its files exactly as at that commit (a fresh clone has none checked out yet)
    git -C "$MGU_STORE" -c advice.detachedHead=false checkout -q -f "$MGU_STORE_REV"
    [ "$(git -C "$MGU_STORE" rev-parse HEAD)" = "$MGU_STORE_REV" ] && [ -z "$(git -C "$MGU_STORE" status --porcelain)" ] \
        || { echo "mgu-store is not clean at $MGU_STORE_REV" >&2; exit 1; }
    echo "mgu-store: $(git -C "$MGU_STORE" log -1 --format='%h %s')"
}

kit_image() {
    printf 'FROM node:22-slim\nRUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*\n' \
        | docker build -q -t "$KIT_IMAGE" - >/dev/null
}

# docker run in the kit image with the repository at /w (and mgu-store); the container is removed when it ends
run_kit() {
    docker run --rm -e PYTHONDONTWRITEBYTECODE=1 -e SOURCE_DATE_EPOCH= -v "$ROOT:/w" -v "$MGU_STORE:/mgu-store:ro" -w /w \
        "$KIT_IMAGE" sh -c "$1"
}

if [ "${1:-}" = usb ]; then
    STICK=${2:-}
    FROM=${3:-}
    [ -n "$STICK" ] && [ -d "$STICK" ] || { echo "usage: make usb STICK=/Volumes/<name> [FROM=github:<owner>/<repo>]" >&2; exit 2; }
    case "$FROM" in ""|github:*/*) ;; *) echo "FROM is github:<owner>/<repo>, or empty for this checkout's $OUT" >&2; exit 2 ;; esac
    mgu_store
    kit_image
    STICK=$(cd "$STICK" && pwd)
    if [ -z "$FROM" ]; then
        # this checkout's packages: the stick's folder mgu-repo/idrive7-tidal/ is a source of its own
        [ -f "$OUT/catalog.json" ] || { echo "no $OUT/catalog.json: run make dist first" >&2; exit 1; }
        docker run --rm -v "$ROOT/$OUT:/in/idrive7-tidal:ro" -v "$STICK:/stick" -v "$MGU_STORE:/mgu-store:ro" \
            "$KIT_IMAGE" node /mgu-store/deploy/mgu-install.js usb-repo /stick /in/idrive7-tidal
    else
        # the published `catalog` release: the stick counts as that GitHub source (its mgu-copy.json); a private
        # repository asks for the read-only token at a hidden prompt (never an argument, never kept here)
        docker run --rm -it -v "$STICK:/stick" -v "$MGU_STORE:/mgu-store:ro" \
            "$KIT_IMAGE" node /mgu-store/deploy/mgu-install.js usb-repo /stick "$FROM"
    fi
    exit 0
fi

[ -f native/tidal-player/build/out/tidal-player ] || { echo "no player: run make player first" >&2; exit 1; }
mgu_store
kit_image
rm -rf "$OUT" "$CHECK"
mkdir -p "$OUT" "$CHECK"

echo "== packages"
run_kit "set -e
    node $STORE_IN/deploy/hu artifact native/cmocan-tidal --out $OUT >/dev/null
    python3 tools/dist_app.py cmocan_tidal $OUT
    node tools/dist_catalog.js local $OUT
    mkdir -p $CHECK/unpacked/tool $CHECK/unpacked/app
    for f in $OUT/cmocan-tidal@*.tgz; do tar -xzf \$f -C $CHECK/unpacked/tool; done
    for f in $OUT/cmocan_tidal@*.tgz; do tar -xzf \$f -C $CHECK/unpacked/app; done
    cp $OUT/catalog.json $CHECK/unpacked/
    mkdir -p native/tidal-player/build/dist-check
    cp $CHECK/unpacked/tool/files/tidal-player native/tidal-player/build/dist-check/tidal-player"

echo "== the player inside the tool kit"
sh native/tidal-player/tools/check-target.sh build/dist-check/tidal-player

echo "== kingfisher: everything in the packages, unpacked"
sh tools/git-hooks/kingfisher-scan "$CHECK/unpacked"
echo "kingfisher: nothing found"

echo "== mgu-store's usb-repo, on a scratch stick ($CHECK/stick)"
mkdir -p "$CHECK/stick"
run_kit "set -e
    node $STORE_IN/deploy/mgu-install.js usb-repo $CHECK/stick $OUT
    node $STORE_IN/deploy/mgu-install.js usb-repo $CHECK/stick $OUT/cmocan-tidal@*.tgz $OUT/cmocan_tidal@*.tgz"

echo "== mgu-store's preparation of a package built elsewhere (tools/oap_link.js), with its made-up test donor"
# on the head unit the deploy tool does this with a stock BMW app as the donor: oap-sdk is generated into the app
run_kit "set -e
    rm -rf /tmp/p && mkdir -p /tmp/p/donor /tmp/p/out && cp -R $CHECK/unpacked/app/package /tmp/p/pkg
    node -e '
        const link = require(\"/mgu-store/tools/oap_link.js\");
        const donor = require(\"/mgu-store/tools/test/synthetic_donor.js\").tgz(\"/tmp/p/donor/donor_app@1.0.0.tgz\", { version: \"^24.10.2\" });
        if (!link.needsSdk(\"/tmp/p/pkg\")) throw new Error(\"the app does not ask for oap-sdk\");
        const r = link.preparePackage(\"/tmp/p/pkg\", \"/tmp/p/out/app.tgz\", { donors: [donor] });
        if (!r.sdk || r.sdk.api.indexOf(\"OnlineApp\") < 0) throw new Error(\"no oap-sdk generated: \" + JSON.stringify(r));
        console.log(\"oap_link: oap-sdk generated from \" + r.sdk.donor + \" (\" + r.sdk.api.join(\", \") + \"); certification added to \" + r.certification);
    '"

echo "== tests/dist.test.js"
for n in current node8; do
    if [ $n = node8 ]; then IMG=node:8.9.4-slim; PLAT=--platform=linux/amd64; else IMG=node:22-slim; PLAT=; fi
    # shellcheck disable=SC2086
    docker run --rm $PLAT -e CMOCAN_DIST=$OUT -e CMOCAN_USB=$CHECK/stick -v "$ROOT:/w:ro" -w /w $IMG \
        sh -c 'echo "-- $(node --version)"; node tests/dist.test.js'
done

echo "== $OUT"
ls -l "$OUT" | sed 1d | awk '{ printf "  %10d  %s\n", $5, $9 }'
