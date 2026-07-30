#!/usr/bin/env bash
set -euo pipefail

# Attach this hostname to the Access setup Sodimo already uses. The reusable
# group is an existing account resource; this script does not create or change
# group membership.
readonly DOMAIN="auto-email.sodimo.eu"
readonly APP_NAME="Sodimo — Envois automatiques"
readonly POLICY_NAME="Sodimo staff — accès existant"
readonly STAFF_GROUP_ID="aff45195-219d-4943-8e3d-40f66c06a14d"
readonly ADMIN_EMAIL="thomas@leger.run"
readonly API_ROOT="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/access"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "::error::Commande requise absente: $1"
    exit 1
  }
}

api() {
  local method=$1
  local path=$2
  local payload=${3:-}
  local args=(
    --silent --show-error --fail-with-body
    --request "$method"
    "${API_ROOT}${path}"
    --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
    --header "Content-Type: application/json"
  )
  if [[ -n "$payload" ]]; then
    args+=(--data "$payload")
  fi
  curl "${args[@]}"
}

require_success() {
  local label=$1
  local body=$2
  if [[ $(jq -r '.success // false' <<<"$body") != "true" ]]; then
    echo "::error::${label}"
    jq -r '.errors[]?.message // empty' <<<"$body" >&2
    exit 1
  fi
}

require_command curl
require_command jq
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"

apps_response=$(api GET "/apps?per_page=100")
require_success "Lecture des applications Access impossible" "$apps_response"
matches=$(jq -c --arg domain "$DOMAIN" '[.result[] | select(.domain == $domain)]' <<<"$apps_response")
match_count=$(jq 'length' <<<"$matches")

if (( match_count == 0 )); then
  app_payload=$(jq -n \
    --arg name "$APP_NAME" \
    --arg domain "$DOMAIN" \
    '{
      name: $name,
      type: "self_hosted",
      domain: $domain,
      destinations: [{type: "public", uri: $domain}],
      session_duration: "24h",
      allowed_idps: [],
      auto_redirect_to_identity: false,
      app_launcher_visible: true,
      policies: []
    }')
  app_response=$(api POST "/apps" "$app_payload")
  require_success "Création de l'application Access impossible" "$app_response"
  app=$(jq -c '.result' <<<"$app_response")
  echo "::notice::Application Access attachée à ${DOMAIN}."
elif (( match_count == 1 )); then
  app=$(jq -c '.[0]' <<<"$matches")
  echo "::notice::Application Access déjà présente pour ${DOMAIN}."
else
  echo "::error::Plusieurs applications Access couvrent exactement ${DOMAIN}; aucune modification automatique."
  exit 1
fi

jq -e --arg domain "$DOMAIN" '
  .type == "self_hosted"
  and .domain == $domain
  and ((.allowed_idps // []) | length == 0)
  and .auto_redirect_to_identity == false
' >/dev/null <<<"$app" || {
  echo "::error::L'application ${DOMAIN} existe avec une configuration incompatible."
  exit 1
}

app_id=$(jq -r '.id' <<<"$app")
policy_payload=$(jq -n \
  --arg name "$POLICY_NAME" \
  --arg group_id "$STAFF_GROUP_ID" \
  --arg admin_email "$ADMIN_EMAIL" \
  '{
    name: $name,
    decision: "allow",
    precedence: 1,
    include: [
      {group: {id: $group_id}},
      {email: {email: $admin_email}}
    ],
    exclude: [],
    require: []
  }')

policies_response=$(api GET "/apps/${app_id}/policies")
require_success "Lecture des politiques Access impossible" "$policies_response"
policies=$(jq -c '.result' <<<"$policies_response")
policy_count=$(jq 'length' <<<"$policies")

if (( policy_count == 0 )); then
  policy_response=$(api POST "/apps/${app_id}/policies" "$policy_payload")
  require_success "Attachement de la règle Sodimo existante impossible" "$policy_response"
  echo "::notice::Le groupe sodimo-staff existant protège ${DOMAIN}."
elif (( policy_count == 1 )); then
  existing_name=$(jq -r '.[0].name' <<<"$policies")
  if [[ "$existing_name" != "$POLICY_NAME" ]]; then
    echo "::error::${DOMAIN} possède déjà une politique non gérée (${existing_name}); aucune modification automatique."
    exit 1
  fi
  policy_id=$(jq -r '.[0].id' <<<"$policies")
  policy_response=$(api PUT "/apps/${app_id}/policies/${policy_id}" "$policy_payload")
  require_success "Mise en conformité de la règle Access impossible" "$policy_response"
  echo "::notice::Règle Access existante vérifiée et remise en conformité."
else
  echo "::error::${DOMAIN} possède ${policy_count} politiques; aucune suppression automatique."
  exit 1
fi

verified_response=$(api GET "/apps/${app_id}/policies")
require_success "Vérification finale des politiques impossible" "$verified_response"
jq -e \
  --arg group_id "$STAFF_GROUP_ID" \
  --arg admin_email "$ADMIN_EMAIL" '
    (.result | length) == 1
    and .result[0].decision == "allow"
    and any(.result[0].include[]?; .group.id? == $group_id)
    and any(.result[0].include[]?; ((.email.email? // "") | ascii_downcase) == ($admin_email | ascii_downcase))
  ' >/dev/null <<<"$verified_response" || {
    echo "::error::La vérification finale ne retrouve pas le groupe Sodimo et l'accès administrateur attendus."
    exit 1
  }

headers=$(mktemp)
trap 'rm -f "$headers"' EXIT
status=""
location=""
for attempt in {1..10}; do
  : >"$headers"
  curl --silent --show-error --max-time 30 --output /dev/null --dump-header "$headers" "https://${DOMAIN}/"
  status=$(awk 'toupper($1) ~ /^HTTP\// {code=$2} END {print code}' "$headers")
  location=$(awk 'BEGIN {IGNORECASE=1} /^location:/ {sub(/^[^:]+:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit}' "$headers")
  if [[ "$status" =~ ^30[12378]$ ]] && [[ "$location" == https://sodimo.cloudflareaccess.com/* ]]; then
    break
  fi
  if (( attempt < 10 )); then
    echo "::notice::Propagation Access en cours (${attempt}/10): HTTP ${status}."
    sleep 3
  fi
done
if [[ ! "$status" =~ ^30[12378]$ ]] || [[ "$location" != https://sodimo.cloudflareaccess.com/* ]]; then
  echo "::error::La porte Access n'est pas observable après propagation: HTTP ${status}, Location=${location:-absente}."
  exit 1
fi

echo "::notice::Vérifié: ${DOMAIN} redirige vers le login Sodimo Cloudflare Access (HTTP ${status})."
