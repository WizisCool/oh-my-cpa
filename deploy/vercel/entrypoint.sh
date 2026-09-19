#!/bin/sh
# Entry point for the Vercel demo image.
#
# It exists for one reason: the platform routes traffic to the port it announces in
# PORT and to port 80 when it announces nothing, so the server's listening address
# has to follow that variable at start-up rather than being fixed with ENV. The demo
# therefore starts with no project configuration at all, and still works if the
# operator sets PORT for their own reasons.
#
# Nothing else belongs here. Configuration the demo needs is baked into the image's
# environment, and the fixture, the seeding and the security boundary are the
# application's own - see internal/demo.
set -eu

if [ -n "${PORT:-}" ]; then
  OMCPA_LISTEN_ADDR=":${PORT}"
  export OMCPA_LISTEN_ADDR
fi

exec /usr/local/bin/oh-my-cpa
