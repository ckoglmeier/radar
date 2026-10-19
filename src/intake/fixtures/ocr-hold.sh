#!/bin/sh
# Synthetic helper: no child processes, ignores TERM so tests require hard stop.
trap '' TERM
printf '%s\n%s\n' "$$" "$1" > "$0.started"
while :; do :; done
