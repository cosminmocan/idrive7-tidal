#!/bin/sh
# scan-dist.sh <dir> - kingfisher secret scan of exactly what is about to be uploaded to the GitHub release `catalog`:
# every file in <dir>, with every .tgz unpacked. An upload is not a git push, so the git hooks never see it; this is
# its scan (WORKPLAN rule 8, docs/SECRETS.md). 0 = nothing found; 1 = a finding, nothing to scan, or kingfisher
# missing or failing (a scan that did not run never lets anything by). Tested by tools/test-scan-dist.sh.
DIR=${1:-}
[ -d "$DIR" ] || { echo "scan-dist: usage: scan-dist.sh <dir>" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
W=$(mktemp -d "${TMPDIR:-/tmp}/kf-scan-dist.XXXXXX") || exit 1
trap 'rm -rf "${W:?}/files"; rmdir "${W:?}"' EXIT
mkdir "$W/files" || exit 1
n=0
for f in "$DIR"/*; do
    [ -f "$f" ] || continue
    n=$((n + 1))
    b=$(basename "$f")
    case "$b" in
        *.tgz|*.tar.gz) mkdir -p "$W/files/$b" && tar -xzf "$f" -C "$W/files/$b" || { echo "scan-dist: cannot unpack $b" >&2; exit 1; } ;;
        *) cp "$f" "$W/files/" ;;
    esac
done
[ "$n" -gt 0 ] || { echo "scan-dist: nothing to scan in $DIR" >&2; exit 1; }
KF_HOOK=scan-dist sh "$HERE/git-hooks/kingfisher-scan" "$W/files" --git-history none
