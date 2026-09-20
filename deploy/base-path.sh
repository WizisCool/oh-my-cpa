#!/bin/sh
# Prints the canonical base path for the console, or exits non-zero when the
# configured value is one the application refuses.
#
# The application normalises OMCPA_BASE_PATH itself (internal/config
# NormalizeBasePath accepts "omc", "/omc/" and "/" as the same setting). Anything
# that composes a URL or a proxy matcher from the raw value has to agree with it,
# because a raw value means two different prefixes to two components: `omc` or
# `/omc/` build a Caddy path matcher that never matches a real request, and a
# healthcheck URL that cannot be fetched. This script is the single place that
# mapping is written down for the deployment files.
#
# An empty result means the site root, which is what the application serves when
# OMCPA_BASE_PATH is "/".
set -eu

raw=$(printf '%s' "${OMCPA_BASE_PATH:-}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')

if [ -z "$raw" ]; then
	printf '/omc\n'
	exit 0
fi

case $raw in
*'?'* | *'#'*)
	printf 'OMCPA_BASE_PATH must not contain a query or fragment: %s\n' "$raw" >&2
	exit 1
	;;
esac

case $raw in
/*) path=$raw ;;
*) path=/$raw ;;
esac

# Split on "/" so duplicate slashes, "." segments and a trailing slash collapse
# the way path.Clean does on the application side. ".." is refused rather than
# resolved, matching the application, which rejects parent traversal outright.
#
# Pathname expansion is disabled for the split: the value is a path, and an
# unquoted expansion would otherwise substitute a "*" segment with the names of
# whatever files happen to sit beside the process, while the application keeps the
# literal character.
canonical=
old_ifs=$IFS
case $- in
*f*) set +f ;;
*) set -f ;;
esac
IFS=/
for segment in $path; do
	case $segment in
	'' | .) continue ;;
	..)
		IFS=$old_ifs
		set -f
		printf 'OMCPA_BASE_PATH must not contain parent traversal: %s\n' "$raw" >&2
		exit 1
		;;
	esac
	canonical=$canonical/$segment
done
IFS=$old_ifs
set -f

printf '%s\n' "$canonical"
