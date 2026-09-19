#!/usr/bin/env bash
# Bounded watch for PR 47: CI outcome plus any CodeRabbit review.
set -uo pipefail
REPO=WizisCool/oh-my-cpa
PR=47
for i in $(seq 1 30); do
  checks=$(gh pr checks "$PR" 2>/dev/null | tr '\n' ';' | cut -c1-220)
  reviews=$(gh api "/repos/$REPO/pulls/$PR/reviews" --jq '[.[] | select(.user.login=="coderabbitai[bot]")] | length' 2>/dev/null || echo 0)
  inline=$(gh api "/repos/$REPO/pulls/$PR/comments" --jq '[.[] | select(.user.login=="coderabbitai[bot]")] | length' 2>/dev/null || echo 0)
  echo "[$(date +%H:%M:%S)] reviews=$reviews inline=$inline"; echo "  $checks"
  if [ "${reviews:-0}" -gt 0 ]; then echo "=== review landed ==="; break; fi
  sleep 45
done
echo; echo "=== CodeRabbit findings ==="
gh api "/repos/$REPO/pulls/$PR/comments" --paginate --jq '.[] | select(.user.login=="coderabbitai[bot]") | "\(.path):\(.line // .original_line)\n\(.body[0:400])\n---"' 2>/dev/null | head -80
echo "=== bot replies ==="
gh api "/repos/$REPO/issues/$PR/comments" --paginate --jq '.[] | select(.user.login=="coderabbitai[bot]") | "\(.created_at) :: \(.body | split("\n") | map(select(length>0)) | .[2:5] | join(" | "))"' 2>/dev/null | tail -3
