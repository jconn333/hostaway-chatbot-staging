#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
SESSION_ID="${SESSION_ID:-smoke-session}"
echo "Using BASE_URL=$BASE_URL"
echo "Using SESSION_ID=$SESSION_ID"
echo

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "❌ Missing required command: $1"
    exit 1
  }
}

require_cmd curl
require_cmd node

fail() { echo "❌ $1"; exit 1; }
pass() { echo "✅ $1"; }

http_get() {
  local url="$1"
  curl -sS -f "$url"
}

http_head() {
  local url="$1"
  curl -sS -I -f "$url"
}

post_chat() {
  local message="$1"
  local payload
  payload="$(node -e 'process.stdout.write(JSON.stringify({message: process.argv[1], sessionId: process.argv[2]}))' "$message" "$SESSION_ID")"
  curl -sS -f -X POST "$BASE_URL/chat" \
    -H "Content-Type: application/json" \
    -d "$payload"
}

# Extract .reply from JSON response (no jq required)
json_get_reply() {
  node -e '
    const fs = require("fs");
    const s = fs.readFileSync(0, "utf8");
    let j;
    try { j = JSON.parse(s); } catch (e) { console.error("Invalid JSON:", s); process.exit(2); }
    if (!j || typeof j.reply !== "string") { console.error("Missing reply field:", s); process.exit(3); }
    process.stdout.write(j.reply);
  '
}

# Assert that stdin contains substring
assert_contains() {
  local hay="$1"
  local needle="$2"
  echo "$hay" | grep -qi -- "$needle" || fail "Expected to contain: $needle"
}

echo "1) Root UI loads"
headers="$(http_head "$BASE_URL/")"
echo "$headers" | grep -qi "200" || fail "Root UI did not return 200"
pass "Root UI returns 200"
echo

echo "2) Sandbox route redirects to root"
headers="$(http_head "$BASE_URL/sandbox")"
echo "$headers" | grep -Eq "302|301" || fail "Sandbox did not redirect"
pass "Sandbox redirect works"
echo

echo "3) Hostaway token test (must return ok:true)"
token_json="$(http_get "$BASE_URL/hostaway/test")"
echo "$token_json" | node -e '
  const s = require("fs").readFileSync(0,"utf8");
  let j; try{ j=JSON.parse(s);}catch(e){ console.error(s); process.exit(2); }
  if (!j.ok) process.exit(3);
' || fail "Hostaway token test failed"
pass "Hostaway token ok:true"
echo

echo "4) Availability: Red Fern tonight (expects available OR not available, but must mention Red Fern dates line)"
resp="$(post_chat "Is the Red Fern Cabin available tonight?")"
reply="$(echo "$resp" | json_get_reply)"
# Strict-ish expectations: must mention "Red Fern" OR "this unit" + dates format YYYY-MM-DD
echo "$reply" | grep -Eq '[0-9]{4}-[0-9]{2}-[0-9]{2}' || fail "Expected date(s) in reply, got: $reply"
assert_contains "$reply" "Book now:"
pass "Red Fern tonight returns dates + booking link"
echo

echo "5) Availability: explicit range"
resp="$(post_chat "Is the Joy Suite available from 2026-03-24 to 2026-03-26?")"
reply="$(echo "$resp" | json_get_reply)"
assert_contains "$reply" "2026-03-24"
assert_contains "$reply" "2026-03-26"
assert_contains "$reply" "Book now:"
pass "Explicit range returns expected dates + booking link"
echo

echo "6) Session debug (expects session state present)"
session_json="$(http_get "$BASE_URL/session/debug?sessionId=$SESSION_ID")"
echo "$session_json" | node -e '
  const s=require("fs").readFileSync(0,"utf8");
  let j; try{j=JSON.parse(s)}catch(e){console.error(s);process.exit(2)}
  if(!j.ok) process.exit(3);
  if(!j.session || !j.session.listingId) process.exit(4);
' || fail "Session debug did not return listingId"
pass "Session debug ok:true with listingId"
echo

echo "7) General Q&A: pet policy (must not crash; must respond non-empty)"
resp="$(post_chat "Does the Red Fern Cabin allow pets?")"
reply="$(echo "$resp" | json_get_reply)"
[ "${#reply}" -ge 10 ] || fail "Reply too short: $reply"
pass "Pet policy produced a non-trivial reply"
echo

echo "8) Collection query: hot tubs (expects list-like content)"
resp="$(post_chat "Which units have hot tubs?")"
reply="$(echo "$resp" | json_get_reply)"
# Expect it to mention hot tub(s) and at least one bullet-ish marker
assert_contains "$reply" "hot"
echo "$reply" | grep -Eq '•|- ' || fail "Expected bullet list in hot tub reply, got: $reply"
pass "Hot tub collection query returns list"
echo

echo "9) Follow-up amenity (expects same list on 'What about that?')"
resp="$(post_chat "What about that?")"
reply="$(echo "$resp" | json_get_reply)"
assert_contains "$reply" "hot"
echo "$reply" | grep -Eq '•|- ' || fail "Expected bullet list in follow-up reply, got: $reply"
pass "Amenity follow-up reuses last amenity"
echo

echo "10) Policy follow-up (pets list after general policy)"
resp="$(post_chat "Are pets allowed?")"
reply="$(echo "$resp" | json_get_reply)"
assert_contains "$reply" "pets"
resp="$(post_chat "Which ones allow pets?")"
reply="$(echo "$resp" | json_get_reply)"
echo "$reply" | grep -Eq '•|- ' || fail "Expected bullet list in pet-friendly reply, got: $reply"
pass "Policy follow-up returns pet-friendly list"
echo

echo "11) Summary tone includes follow-up question"
resp="$(post_chat "Tell me about Red Fern Cabin")"
reply="$(echo "$resp" | json_get_reply)"
assert_contains "$reply" "Would you like me to check availability"
pass "Summary includes conversational follow-up"
echo

echo "12) Unknown unit -> should ask for clarification"
resp="$(post_chat "Is the cabin available tonight?")"
reply="$(echo "$resp" | json_get_reply)"
assert_contains "$reply" "Which unit"
pass "Unknown unit triggers clarification"
echo

echo "✅ STRICT terminal smoke sequence complete."
