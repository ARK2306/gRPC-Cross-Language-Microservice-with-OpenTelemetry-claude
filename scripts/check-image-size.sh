#!/usr/bin/env bash
#
# Assert that container images fit the project's size budget.
#
# Usage: scripts/check-image-size.sh [--max-mb 300] IMAGE [IMAGE...]
#
# Reads the size Docker itself reports in `docker images`, rather than
# `docker image inspect --format '{{.Size}}'`: with the containerd image store
# the latter reports the *compressed* size, which understates the image by a
# factor of two or more and would let an oversized image pass.

set -euo pipefail

max_mb=300
images=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-mb) max_mb="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) images+=("$1"); shift ;;
  esac
done

if [[ ${#images[@]} -eq 0 ]]; then
  echo "error: no images given" >&2
  exit 2
fi

# "251MB" / "1.2GB" / "986kB" -> megabytes (SI, matching Docker's own output).
to_mb() {
  awk -v raw="$1" 'BEGIN {
    if (match(raw, /^[0-9.]+/) == 0) { print "-1"; exit }
    value = substr(raw, RSTART, RLENGTH) + 0
    unit  = substr(raw, RSTART + RLENGTH)
    if      (unit ~ /^GB/) value *= 1000
    else if (unit ~ /^MB/) value *= 1
    else if (unit ~ /^kB/) value /= 1000
    else if (unit ~ /^B/)  value /= 1000000
    printf "%.1f", value
  }'
}

status=0
printf '%-52s %10s   %s\n' "IMAGE" "SIZE" "BUDGET ${max_mb}MB"

for image in "${images[@]}"; do
  raw="$(docker images --format '{{.Size}}' --filter "reference=${image}" | head -1)"

  if [[ -z "$raw" ]]; then
    printf '%-52s %10s   %s\n' "$image" "-" "MISSING (build it first)"
    status=1
    continue
  fi

  mb="$(to_mb "$raw")"
  if awk -v a="$mb" -v b="$max_mb" 'BEGIN { exit !(a < b) }'; then
    printf '%-52s %10s   %s\n' "$image" "$raw" "OK"
  else
    printf '%-52s %10s   %s\n' "$image" "$raw" "OVER BUDGET"
    status=1
  fi
done

exit $status
