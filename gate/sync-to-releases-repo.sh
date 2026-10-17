#!/usr/bin/env bash
# Push the release-gate suite + workflow to the PUBLIC installers repo, where
# Actions minutes are free and the real windows-latest / ubuntu-latest runners
# live. The source repo stays private: only this directory goes over
# (Playwright spec, config, a WAV fixture, the workflow). Its layout there:
#   .github/workflows/release-gate.yml   ← release-gate.yml
#   gate/                                ← this directory (minus node_modules/out)
#
#   scripts/desktop/release-gate/sync-to-releases-repo.sh ["commit message"]
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=${IB_DESKTOP_RELEASE_REPO_FULL:-MrYungCEO/infinibot-desktop-releases}
MSG=${1:-"release gate: sync from InfiniBot $(git -C "$HERE" rev-parse --short HEAD)"}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
gh repo clone "$REPO" "$TMP/r" -- --depth 1 -q
mkdir -p "$TMP/r/.github/workflows" "$TMP/r/gate"
rm -rf "$TMP/r/gate"/*
cp "$HERE/release-gate.yml" "$TMP/r/.github/workflows/release-gate.yml"
tar -C "$HERE" --exclude=node_modules --exclude=out --exclude=release-gate.yml -cf - . | tar -C "$TMP/r/gate" -xf -
cd "$TMP/r"
git add -A
if git diff --cached --quiet; then echo "releases repo already up to date"; exit 0; fi
git -c user.name="$(git -C "$HERE" config user.name)" -c user.email="$(git -C "$HERE" config user.email)" commit -qm "$MSG"
git push -q origin HEAD
echo "pushed $(git rev-parse --short HEAD) to $REPO"
