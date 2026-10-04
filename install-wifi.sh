#!/usr/bin/env bash
# install-wifi.sh — pair (first time) + connect + install pi-termux-mobile APK
# over wireless adb. Phone: Developer options -> Wireless debugging.
#
#   ./install-wifi.sh                 # auto-discover via mDNS, pair if needed
#   PI_CODE=123456 ./install-wifi.sh  # skip code prompt (from pairing dialog)
#
# After the first successful pair the phone remembers this host; later runs
# only connect + install (a re-pair is only needed after "Forget paired
# devices" or certificate change).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADB="${ADB:-$HERE/tools/android-sdk/platform-tools/adb}"
APK="${APK:-$HERE/android/app/build/outputs/apk/debug/app-debug.apk}"

[ -x "$ADB" ] || { echo "adb not found: $ADB" >&2; exit 1; }
[ -f "$APK" ] || { echo "APK not found: $APK (run ./gradlew assembleDebug first)" >&2; exit 1; }

die() { echo "error: $*" >&2; exit 1; }

mdns_row() { # $1 = service type suffix (_adb-tls-pairing._tcp | _adb-tls-connect._tcp)
  timeout 10 "$ADB" mdns services 2>/dev/null \
    | awk -v s="$1" '$2 ~ s {print $3; exit}'
}

connected() {
  "$ADB" devices | awk 'NR>1 && $2=="device" {print $1; exit}'
}

# 1. already connected?
DEV="$(connected || true)"

if [ -z "$DEV" ]; then
  # 2. look for a pairing advertisement (open "Pair with pairing code" on the phone)
  PAIR_EP="$(mdns_row _adb-tls-pairing._tcp || true)"
  if [ -n "$PAIR_EP" ]; then
    CODE="${PI_CODE:-}"
    if [ -z "$CODE" ]; then
      read -r -p "pairing code shown on the phone ($PAIR_EP): " CODE
    fi
    "$ADB" pair "$PAIR_EP" "$CODE" || die "pairing failed (wrong code? dialog closed?)"
  fi

  # 3. connect via the tls-connect endpoint
  CONNECT_EP="$(mdns_row _adb-tls-connect._tcp || true)"
  if [ -z "$CONNECT_EP" ]; then
    # no mDNS (or phone screen off) -> manual fallback
    read -r -p "no device found via mDNS; enter phone IP:port (from 'Wireless debugging' screen, e.g. 192.168.8.184:37791), or empty to abort: " CONNECT_EP
    [ -n "$CONNECT_EP" ] || die "no endpoint"
  fi
  "$ADB" connect "$CONNECT_EP" || die "connect failed"
  DEV="$(connected || true)"
  [ -n "$DEV" ] || die "connected, but 'adb devices' is empty"
fi

echo "device: $DEV"
"$ADB" -s "$DEV" install -r "$APK"
echo "installed: $APK"

# optional: start app and show bridge port once the runtime is up
"$ADB" -s "$DEV" shell am start -n org.pimobile.app/.MainActivity >/dev/null
echo "app started; bridge port (after first-boot extraction):"
echo "  $ADB -s $DEV shell run-as org.pimobile.app cat /data/data/org.pimobile.app/files/.pi-mobile/port"
echo "runtime log: ... files/log/node.log (same run-as trick)"
