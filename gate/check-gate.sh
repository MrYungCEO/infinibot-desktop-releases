#!/usr/bin/env bash
# Is there a PASSING release-gate run for these exact installers?
#
#   scripts/desktop/release-gate/check-gate.sh <InfiniBot-Setup-x64.exe> <InfiniBot-x86_64.AppImage>
#
# The release gate (.github/workflows/release-gate.yml on the public releases
# repo) installs the exe on a real windows-latest runner and the AppImage on a
# real ubuntu-latest runner, both with no Node on PATH, and clicks through the
# whole onboarding (brain quick options, Ollama Cloud, native voice, first
# chat, update widget, external links). Only when BOTH platforms pass does its
# `verdict` job upload an artifact named
#   release-gate-pass-<exe sha256[0:16]>-<appimage sha256[0:16]>
# holding verdict.json with the full hashes. This script finds that artifact,
# checks the run concluded `success` on `main` and the full hashes match.
# Exit 0 = gate passed (prints the run URL), 1 = no passing run.
set -euo pipefail
EXE=${1:?exe}; APPIMAGE=${2:?AppImage}
REPO=${IB_DESKTOP_RELEASE_REPO_FULL:-MrYungCEO/infinibot-desktop-releases}
EXE_SHA=$(sha256sum "$EXE" | cut -d' ' -f1)
APP_SHA=$(sha256sum "$APPIMAGE" | cut -d' ' -f1)
NAME="release-gate-pass-${EXE_SHA:0:16}-${APP_SHA:0:16}"
echo "release gate: exe $EXE_SHA"
echo "release gate: AppImage $APP_SHA"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
gh api "repos/$REPO/actions/artifacts?name=$NAME&per_page=100" \
  --jq '.artifacts[] | select(.expired == false) | "\(.id) \(.workflow_run.id)"' > "$TMP/artifacts" || true
while read -r ART_ID RUN_ID; do
  [ -n "${RUN_ID:-}" ] || continue
  RUN=$(gh api "repos/$REPO/actions/runs/$RUN_ID" \
    --jq '"\(.conclusion) \(.head_branch) \(.path) \(.html_url)"') || continue
  read -r CONCLUSION BRANCH WF_PATH URL <<<"$RUN"
  [ "$CONCLUSION" = success ] && [ "$BRANCH" = main ] \
    && [ "$WF_PATH" = .github/workflows/release-gate.yml ] || continue
  rm -rf "$TMP/v" && mkdir -p "$TMP/v"
  gh api "repos/$REPO/actions/artifacts/$ART_ID/zip" > "$TMP/v.zip" || continue
  (cd "$TMP/v" && unzip -q ../v.zip) || continue
  V="$TMP/v/verdict.json"
  [ -f "$V" ] || continue
  if grep -q '"result": *"pass"' "$V" && grep -q "\"exe_sha256\": *\"$EXE_SHA\"" "$V" \
     && grep -q "\"appimage_sha256\": *\"$APP_SHA\"" "$V"; then
    echo "release gate PASSED: $URL"
    exit 0
  fi
done < "$TMP/artifacts"
echo "release gate: NO passing run for these exact installers (artifact $NAME)." >&2
echo "  Upload them as a draft:  scripts/desktop/publish-github-release.sh --candidate <dir> <version>" >&2
echo "  then run the gate:       gh workflow run release-gate.yml -R $REPO -f tag=v<version>" >&2
exit 1
