#!/usr/bin/env bash
# Waits out CodeRabbit's OSS review limit (~13:22Z), re-requests the review, then reports.
set -uo pipefail
REPO=WizisCool/oh-my-cpa
PR=47
TARGET=$(date -u -d '2026-09-19T13:25:00Z' +%s)
NOW=$(date -u +%s)
if [ "$NOW" -lt "$TARGET" ]; then
  echo "等待额度恢复：$(( (TARGET - NOW) / 60 )) 分钟"
  sleep $(( TARGET - NOW ))
fi
echo "[$(date -u +%H:%M:%SZ)] 重新请求审查"
gh pr comment "$PR" --body "@coderabbitai review

Retrying now that the OSS review limit has reset. \`78ed1e7\`, CI green (\`static\` + \`browser\`); the PR body records the three fixed findings, the loopback decision kept in ADR 0013, and the out-of-scope client-keys findings." >/dev/null && echo "  已提交请求"
for i in $(seq 1 26); do
  reviews=$(gh api "/repos/$REPO/pulls/$PR/reviews" --jq '[.[] | select(.user.login=="coderabbitai[bot]")] | length' 2>/dev/null || echo 0)
  inline=$(gh api "/repos/$REPO/pulls/$PR/comments" --jq '[.[] | select(.user.login=="coderabbitai[bot]")] | length' 2>/dev/null || echo 0)
  last=$(gh api "/repos/$REPO/issues/$PR/comments" --paginate --jq '[.[] | select(.user.login=="coderabbitai[bot]")] | last | .created_at' 2>/dev/null || echo none)
  echo "[$(date -u +%H:%M:%SZ)] reviews=$reviews inline=$inline last_bot=$last"
  if [ "${reviews:-0}" -gt 0 ]; then echo "=== 审查已到达 ==="; break; fi
  if [ "$last" != "2026-09-19T12:53:56Z" ] && [ "$last" != "none" ]; then echo "=== 机器人有新回复 ==="; break; fi
  sleep 45
done
echo; echo "=== 审查意见 ==="
gh api "/repos/$REPO/pulls/$PR/comments" --paginate --jq '.[] | select(.user.login=="coderabbitai[bot]") | "\(.path):\(.line // .original_line)\n\(.body[0:500])\n---"' 2>/dev/null | head -100
echo "=== 机器人最新回复 ==="
gh api "/repos/$REPO/issues/$PR/comments" --paginate --jq '[.[] | select(.user.login=="coderabbitai[bot]")] | last | .body' 2>/dev/null | head -40
