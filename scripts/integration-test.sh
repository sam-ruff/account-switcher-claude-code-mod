#!/usr/bin/env bash
# Runs two real Claude Code sessions side by side on one throwaway HOME, pointed at a
# fake API. Session A stays on the default account. Session B switches to a second
# account and back. The fake API records which token each session sent, and both
# sessions run /status. No request reaches Anthropic.
#
# Usage: scripts/integration-test.sh [path-to-claude]
# Needs python3 with pyte (uv pip install pyte).
set -uo pipefail

CLAUDE=$(command -v "${1:-claude}")
ROOT=$(cd "$(dirname "$0")/.." && pwd)
MOD="$ROOT/mods/account-switcher"
LIB="$ROOT/scripts/lib"
PYTHON=${PYTHON:-python3}
PORT=${PORT:-53998}
WORK=$(mktemp -d)
trap 'kill $api 2>/dev/null; rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
"$PYTHON" -c 'import pyte' 2>/dev/null || fail "python3 needs pyte (uv pip install pyte)"

H="$WORK/home"
mkdir -p "$H/.claude/accounts/aaaa_org-aaaa" "$WORK/project"
cat > "$H/.claude.json" <<EOF
{"hasCompletedOnboarding": true, "theme": "dark", "projects": {"$WORK/project": {"hasTrustDialogAccepted": true}}, "oauthAccount": {"accountUuid": "bbbb", "emailAddress": "bob@example.com", "organizationUuid": "org-bbbb", "organizationName": "Bob Org"}}
EOF
cat > "$H/.claude/.credentials.json" <<'EOF'
{"claudeAiOauth": {"accessToken": "token-bob", "refreshToken": "refresh-bob", "expiresAt": 4102444800000, "scopes": ["user:inference", "user:profile"], "subscriptionType": "pro"}}
EOF
cat > "$H/.claude/accounts/aaaa_org-aaaa/.credentials.json" <<'EOF'
{"claudeAiOauth": {"accessToken": "token-alice", "refreshToken": "refresh-alice", "expiresAt": 4102444800000, "scopes": ["user:inference", "user:profile"], "subscriptionType": "max"}}
EOF
cat > "$H/.claude/accounts/aaaa_org-aaaa/account.json" <<'EOF'
{"label": "Work", "oauthAccount": {"accountUuid": "aaaa", "emailAddress": "alice@acme.example", "organizationUuid": "org-aaaa", "organizationName": "Acme"}}
EOF
chmod -R go-rwx "$H/.claude"

"$PYTHON" "$LIB/fake_api.py" "$PORT" "$WORK/requests.log" & api=$!
sleep 1
export DRIVE_BASE_URL=http://127.0.0.1:$PORT

DRIVE_TAG=A "$PYTHON" "$LIB/drive.py" "$WORK/project" "$H" "$CLAUDE" "$MOD" \
  '[["type","one"],["key","enter"],["wait",14],["type","two"],["key","enter"],["wait",6],["type","/status"],["wait",0.4],["key","enter"],["wait",4],["screen","A status"],["key","esc"],["wait",12]]' \
  > "$WORK/A.out" 2>&1 &
a=$!
sleep 2
DRIVE_TAG=B "$PYTHON" "$LIB/drive.py" "$WORK/project" "$H" "$CLAUDE" "$MOD" \
  '[["type","one"],["key","enter"],["wait",4],["key","kp_minus_xterm"],["wait",2],["key","down"],["key","enter"],["wait",3],["screen","B switched"],["type","two"],["key","enter"],["wait",5],["type","/status"],["wait",0.4],["key","enter"],["wait",4],["screen","B status"],["key","esc"],["wait",1],["type","/account-switch 1"],["wait",0.4],["key","enter"],["wait",3],["type","three"],["key","enter"],["wait",5]]' \
  > "$WORK/B.out" 2>&1
wait $a

tokens() { grep "^$1 " "$WORK/requests.log" | awk '{print $2}' | uniq | paste -sd' '; }
email() { sed -n "/===== $1 status/,/=====/p" "$WORK/$1.out" | sed -n 's/.*Email: *\([^ ]*\).*/\1/p' | head -1; }

echo "A sent: $(tokens A)"
echo "B sent: $(tokens B)"
echo "A /status: $(email A)"
echo "B /status: $(email B)"

[ "$(tokens A)" = "token-bob" ] || fail "session A should only ever use bob's token"
[ "$(tokens B)" = "token-bob token-alice token-bob" ] || fail "session B should use bob, then alice after the switch, then bob again"
[ "$(email A)" = "bob@example.com" ] || fail "session A's /status should show bob"
[ "$(email B)" = "alice@acme.example" ] || fail "session B's /status should show alice"
grep -q "Account: Work" "$WORK/B.out" || fail "session B's band should name Work after switching"
grep -q '"refresh-bob"' "$H/.claude/.credentials.json" || fail "the default login was changed"
[ "$(stat -c %a "$H/.claude/accounts")" = 700 ] || fail "accounts directory is not 0700"
left=$(find "$H/.claude" "$H" -maxdepth 3 -name '*.lock' -not -path '*/ide/*')
[ -z "$left" ] || fail "a lock was left behind: $left"

echo PASS
