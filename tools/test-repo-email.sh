#!/bin/sh
# test-repo-email.sh - every commit on every branch and tag carries only the owner's GitHub no-reply address as
# author and committer (WORKPLAN.md E0; the owner's real address must never be in a commit). Part of make test-hooks.
ALLOWED='20535086+cosminmocan@users.noreply.github.com'
cd "$(dirname "$0")/.." || exit 1
others=$(git log --branches --tags --format='%ae%n%ce' | sort -u | grep -vxF "$ALLOWED")
if [ -n "$others" ]; then
    echo "FAIL  commits carry other addresses than the no-reply one: $(echo "$others" | wc -l | tr -d ' ') address(es)"
    exit 1
fi
[ "$(git config user.email)" = "$ALLOWED" ] || { echo "FAIL  git config user.email is not the no-reply address (new commits would expose another)"; exit 1; }
echo "ok    every commit, and this checkout's git config, use the no-reply address"
