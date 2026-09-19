#!/usr/bin/env bash
# 等待 PR 47 的审查真正落地（review 对象或 inline 意见出现）。
set -uo pipefail
REPO=WizisCool/oh-my-cpa
PR=47
for i in $(seq 1 30); do
  reviews=$(gh api "/repos/$REPO/pulls/$PR/reviews" --jq '[.[] | select(.user.login=="coderabbitai[bot]")] | length' 2>/dev/null || echo 0)
  inline=$(gh api "/repos/$REPO/pulls/$PR/comments" --jq '[.[] | select(.user.login=="coderabbitai[bot]")] | length' 2>/dev/null || echo 0)
  last=$(gh api "/repos/$REPO/issues/$PR/comments" --paginate --jq '[.[] | select(.user.login=="coderabbitai[bot]")] | last | .created_at' 2>/dev/null || echo none)
  echo "[$(date -u +%H:%M:%SZ)] reviews=$reviews inline=$inline last_bot=$last"
  if [ "${reviews:-0}" -gt 0 ] || [ "${inline:-0}" -gt 0 ]; then echo "=== 审查已落地 ==="; break; fi
  sleep 60
done
echo; echo "=== 审查意见（逐条） ==="
gh api "/repos/$REPO/pulls/$PR/comments" --paginate --jq '.[] | select(.user.login=="coderabbitai[bot]") | "\(.path):\(.line // .original_line)\n\(.body[0:600])\n---"' 2>/dev/null | head -120
echo "=== review 正文 ==="
gh api "/repos/$REPO/pulls/$PR/reviews" --jq '.[] | select(.user.login=="coderabbitai[bot]") | .body[0:800]' 2>/dev/null | head -40
echo "=== 机器人最新回复 ==="
gh api "/repos/$REPO/issues/$PR/comments" --paginate --jq '[.[] | select(.user.login=="coderabbitai[bot]")] | last | .body' 2>/dev/null | head -30
