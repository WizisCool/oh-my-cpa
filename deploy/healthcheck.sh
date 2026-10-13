#!/bin/sh
set -eu
# One image runs two roles, and the updater has no console port to probe. Asking which
# process this container runs keeps a hand-written `command: ["updater", "serve"]` service
# from needing a health check of its own to avoid being reported unhealthy forever.
if tr '\0' ' ' < /proc/1/cmdline | grep -q ' updater serve'; then
  exec /usr/local/bin/oh-my-cpa updater healthcheck
fi
base_path=$(sh /usr/local/bin/omc-base-path)
listen_addr=${OMCPA_LISTEN_ADDR:-:8080}
case "$listen_addr" in
  :* | 0.0.0.0:*) probe_addr="127.0.0.1:${listen_addr##*:}" ;;
  '[::]:'*) probe_addr="[::1]:${listen_addr##*:}" ;;
  *) probe_addr=$listen_addr ;;
esac
# Degraded means the process is ready but CPA is unavailable; restarting OMC cannot fix CPA.
wget -q -O - "http://${probe_addr}${base_path}/api/healthz" | grep -q '"status":"\(ok\|degraded\)"'
