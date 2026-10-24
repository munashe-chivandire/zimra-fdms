#!/usr/bin/env bash
# Posts one comment on the issue that started this triage run, and no other
# issue. The comment body is read from stdin.
#
# Usage: triage-comment.sh <<'EOF'
#        comment text
#        EOF
set -euo pipefail
: "${ISSUE_NUMBER:?ISSUE_NUMBER must be set by the workflow}"

if [[ $# -ne 0 ]]; then
  echo "triage-comment.sh takes no arguments; pass the body on stdin" >&2
  exit 1
fi

body="$(cat)"
if [[ -z "${body//[[:space:]]/}" ]]; then
  echo "empty comment body" >&2
  exit 1
fi

printf '%s\n' "$body" | gh issue comment "$ISSUE_NUMBER" --body-file -
