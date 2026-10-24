#!/usr/bin/env bash
# Adds labels to the issue that started this triage run, and no other issue.
# The issue number comes from the workflow, not from the caller, so a crafted
# issue can't point the triage bot at someone else's issue.
#
# Usage: triage-label.sh <label> [label...]
set -euo pipefail
: "${ISSUE_NUMBER:?ISSUE_NUMBER must be set by the workflow}"

allowed=(bug enhancement question documentation spec-drift needs-info security duplicate)

args=()
for label in "$@"; do
  ok=false
  for a in "${allowed[@]}"; do
    if [[ "$label" == "$a" ]]; then ok=true; fi
  done
  if [[ "$ok" != true ]]; then
    echo "label not allowed: $label (allowed: ${allowed[*]})" >&2
    exit 1
  fi
  args+=(--add-label "$label")
done

if [[ ${#args[@]} -eq 0 ]]; then
  echo "usage: triage-label.sh <label> [label...]" >&2
  exit 1
fi

gh issue edit "$ISSUE_NUMBER" "${args[@]}"
