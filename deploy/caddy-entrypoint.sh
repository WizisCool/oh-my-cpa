#!/bin/sh
# Starts the bundled Caddy on the base path the application will actually serve.
#
# Caddy substitutes {$OMCPA_BASE_PATH} before it parses the Caddyfile, and a path
# matcher has to start with exactly one slash. A raw operator value therefore
# breaks the proxy in two silent ways: "omc" yields an invalid `omc/*` matcher,
# and "/omc/" yields `/omc//*`, which Caddy only matches against a request that
# contains a real double slash - so every console request fell through to the
# CPA upstream instead. Normalising here keeps the proxy and the application on
# one prefix, which is the entire purpose of OMCPA_BASE_PATH.
set -eu

canonical=$(sh /usr/local/bin/omc-base-path)
export OMCPA_BASE_PATH=$canonical

if [ -z "$canonical" ]; then
	# "/" puts the console on the site root. No prefix is left to route on, so the
	# co-deployed CPA is not reachable through this proxy in that mode.
	exec caddy run --config /etc/caddy/Caddyfile.root --adapter caddyfile
fi

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
