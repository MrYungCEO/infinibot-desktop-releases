#!/usr/bin/env bash
# Local FAST PRE-CHECK of the release gate (same Playwright suite as CI):
#   scripts/desktop/release-gate/run-local.sh <InfiniBot-x86_64.AppImage>
#   scripts/desktop/release-gate/run-local.sh --wine <InfiniBot-Setup-x64.exe>
#
# NOT a substitute for the real-Windows run: Wine hid every 2026.10.18 Windows
# bug. Only .github/workflows/release-gate.yml on the releases repo counts for
# publishing (check-gate.sh).
#
# Isolation: throwaway HOME (so the app's state dir and electron userData are
# fresh), env -i (no INFINIBOT_STATE_DIR from the spawn env → never the live
# gateway), a PATH with node/npm/npx removed, its own Xvfb display. Kills
# everything it started (by the HOME in /proc/<pid>/environ, never pkill -f).
# Env: IB_GATE_KEEP=1 keeps the scratch dir; IB_GATE_SKIP=check,ids;
#      IB_GATE_NODE=/path/to/node (runs Playwright; default: nvm v22 or `node`).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WINE=0
if [ "${1:-}" = --wine ]; then WINE=1; shift; fi
ART=$(readlink -f "${1:?AppImage or exe}")
NODE=${IB_GATE_NODE:-$(ls -d "$HOME"/.nvm/versions/node/v22*/bin/node 2>/dev/null | tail -1)}
NODE=${NODE:-$(command -v node)}
[ -d "$HERE/node_modules/@playwright/test" ] || (cd "$HERE" && "$(dirname "$NODE")/npm" install --no-audit --no-fund --no-save @playwright/test@1.64.1)

S=$(mktemp -d /tmp/ib-gate-local.XXXXXX)
OUTDIR="$HERE/out"
rm -rf "$OUTDIR"; mkdir -p "$S/home" "$S/bin"
echo "scratch $S"

# PATH without node/npm/npx/corepack: a dir of symlinks to /usr/bin + /bin.
for d in /usr/bin /bin /usr/sbin; do
  for f in "$d"/*; do
    b=$(basename "$f")
    case "$b" in node|nodejs|npm|npx|corepack|yarn|pnpm) continue ;; esac
    [ -e "$S/bin/$b" ] || ln -s "$f" "$S/bin/$b"
  done
done
CLEAN_PATH="$S/bin"
if env -i PATH="$CLEAN_PATH" sh -c 'command -v node || command -v npm' >/dev/null; then echo "node still on PATH"; exit 1; fi

# Own Xvfb.
XVFB=$(command -v Xvfb || echo /tmp/ib-xvfb/root/usr/bin/Xvfb)
DISP=:$((90 + RANDOM % 9))
while [ -e "/tmp/.X11-unix/X${DISP#:}" ]; do DISP=:$((90 + RANDOM % 9)); done
"$XVFB" "$DISP" -screen 0 1440x900x24 -nolisten tcp >"$S/xvfb.log" 2>&1 &
XPID=$!
sleep 1

APP="$ART"; PLATFORM=linux; EXTRA=()
if [ "$WINE" = 1 ]; then
  PLATFORM=wine
  export WINEPREFIX="$S/wine"
  echo "== wine: silent NSIS install"
  env -i HOME="$S/home" WINEPREFIX="$WINEPREFIX" DISPLAY="$DISP" PATH="$CLEAN_PATH" WINEDEBUG=-all \
    wine "$ART" /S '/D=C:\IBGate\InfiniBot' >"$S/wine-install.log" 2>&1 || true
  EXE="$WINEPREFIX/drive_c/IBGate/InfiniBot/InfiniBot.exe"
  [ -f "$EXE" ] || { echo "wine install failed"; tail "$S/wine-install.log"; exit 1; }
  APP="$S/wine-app.sh"
  printf '#!/bin/sh\nexec wine "%s" "$@"\n' "$EXE" > "$APP"; chmod +x "$APP"
  EXTRA=(WINEPREFIX="$WINEPREFIX" WINEDEBUG=-all)
fi

cleanup() {
  for p in $(ls /proc | grep -E '^[0-9]+$'); do
    grep -qz "^HOME=$S/home$" "/proc/$p/environ" 2>/dev/null && kill "$p" 2>/dev/null || true
  done
  [ "$WINE" = 1 ] && env -i HOME="$S/home" WINEPREFIX="$S/wine" PATH="$CLEAN_PATH" wineserver -k 2>/dev/null || true
  sleep 2
  for p in $(ls /proc | grep -E '^[0-9]+$'); do
    grep -qz "^HOME=$S/home$" "/proc/$p/environ" 2>/dev/null && kill -9 "$p" 2>/dev/null || true
  done
  kill "$XPID" 2>/dev/null || true
  if [ "${IB_GATE_KEEP:-0}" != 1 ]; then rm -rf "$S"; else echo "kept $S"; fi
}
trap cleanup EXIT

set +e
(cd "$HERE" && env -i HOME="$S/home" DISPLAY="$DISP" PATH="$CLEAN_PATH" LANG=C.UTF-8 \
  "${EXTRA[@]}" \
  IB_GATE_APP="$APP" IB_GATE_PLATFORM="$PLATFORM" IB_GATE_SKIP="${IB_GATE_SKIP:-}" \
  IB_GATE_EXPECT_VERSION="${IB_GATE_EXPECT_VERSION:-}" IB_GATE_APP_ARGS="${IB_GATE_APP_ARGS---disable-gpu}" \
  "$NODE" node_modules/@playwright/test/cli.js test)
RC=$?
set -e
echo "== results: $OUTDIR/summary.md (exit $RC)"
cat "$OUTDIR/summary.md" 2>/dev/null || true
exit $RC
