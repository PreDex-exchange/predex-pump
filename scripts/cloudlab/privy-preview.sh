#!/usr/bin/env bash
set -euo pipefail

# Development preview of the Privy wallet path on pc63, against an explicitly
# supplied API. `up` first requires that API's /config to match this source's
# shared ARC chain and contract addresses. Lifecycle is scripts/qa-stack.sh;
# browser QA uses the pinned browse from scripts/cloudlab/bootstrap-browse.sh.
# `up` never starts a backend, indexer, database, or the canonical runtime.
#
# `api-up` runs only the API entry (`pnpm api`, backend/src/api.ts) of the
# verified isolated source as the loopback transient user unit
# predex-privy-api.service, against the already-running databases. It never
# starts data containers, the indexer, or the operator, and holds the isolated
# root's runtime/active marker so sync.sh refuses to replace its source.
#
#   PREDEX_PREVIEW_API_URL=<https API base> NEXT_PUBLIC_PRIVY_APP_ID=<public id> \
#     [NEXT_PUBLIC_PRIVY_CLIENT_ID=<public id>] scripts/cloudlab/privy-preview.sh up
#   scripts/cloudlab/privy-preview.sh api-up | api-down
#   scripts/cloudlab/privy-preview.sh status | down
#   scripts/cloudlab/privy-preview.sh browse <browse args...>

CLOUDLAB_HOST="${CLOUDLAB_HOST:-}"
CLOUDLAB_IDENTITY_FILE="${CLOUDLAB_IDENTITY_FILE:-/Users/ggattacker/.ssh/cloudlab}"
CLOUDLAB_REMOTE_ROOT="${CLOUDLAB_REMOTE_ROOT:-/users/span14/predex-builds/predex-pump-privy}"

fail() {
  printf 'privy-preview: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'Usage: %s up | down | api-up | api-down | status | browse <args...>\n' "$0" >&2
  printf '  up requires PREDEX_PREVIEW_API_URL and NEXT_PUBLIC_PRIVY_APP_ID\n' >&2
  printf '  api-up | api-down manage the loopback API at http://127.0.0.1:3001\n' >&2
  exit 2
}

# POSIX single-quoting, so the remote login shell's flavour does not matter.
sq() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

if [[ "$CLOUDLAB_HOST" != 'span14@pc63.cloudlab.umass.edu' ]]; then
  fail "refusing unexpected CloudLab host: $CLOUDLAB_HOST"
fi
if [[ "$CLOUDLAB_REMOTE_ROOT" != /users/span14/predex-builds/predex-pump-privy ]]; then
  fail "refusing unexpected remote root: $CLOUDLAB_REMOTE_ROOT"
fi

public_id_pattern='^[A-Za-z0-9_-]{10,100}$'
api_url_pattern='^(https://[^/?#@[:space:]]+|http://(127\.0\.0\.1|localhost)(:[0-9]+)?)(/[^?#@[:space:]]*)?$'
case "${1:-}" in
  up)
    (($# == 1)) || usage
    app_id="${NEXT_PUBLIC_PRIVY_APP_ID:-}"
    client_id="${NEXT_PUBLIC_PRIVY_CLIENT_ID:-}"
    api_url="${PREDEX_PREVIEW_API_URL:-}"
    [[ "$app_id" =~ $public_id_pattern ]] ||
      fail 'NEXT_PUBLIC_PRIVY_APP_ID must be a public App ID ([A-Za-z0-9_-], 10-100 chars)'
    [[ -z "$client_id" || "$client_id" =~ $public_id_pattern ]] ||
      fail 'NEXT_PUBLIC_PRIVY_CLIENT_ID must be a public Client ID ([A-Za-z0-9_-], 10-100 chars)'
    [[ "$api_url" =~ $api_url_pattern ]] ||
      fail 'PREDEX_PREVIEW_API_URL must be an https:// (or loopback http://) API base without credentials, query, or fragment'
    remote_args=(up "$app_id" "$client_id" "$api_url")
    ;;
  down|status|api-up|api-down)
    (($# == 1)) || usage
    remote_args=("$1")
    ;;
  browse)
    (($# > 1)) || usage
    remote_args=("$@")
    ;;
  *)
    usage
    ;;
esac

# Capture the payload with a top-level heredoc: Bash 3.2 mis-parses quotes in a
# heredoc nested inside $(...). read returns nonzero at EOF, which is expected.
remote_script=''
IFS= read -r -d '' remote_script <<'REMOTE' || true
set -euo pipefail

remote_root="$1"
command_name="$2"
shift 2
frontend_url=http://127.0.0.1:3002
toolchain_root=/users/span14/.local/predex-toolchain
browse_bin="$toolchain_root/gstack-e76f65a8da31/browse/dist/browse"

fail() {
  printf 'privy-preview: %s\n' "$*" >&2
  exit 1
}

[[ "$remote_root" == /users/span14/predex-builds/predex-pump-privy ]] ||
  fail "refusing unexpected remote root: $remote_root"
source_dir="$remote_root/source"
qa_stack="$source_dir/scripts/qa-stack.sh"
[[ -f "$qa_stack" && -f "$source_dir/.predex-source-id" ]] ||
  fail "isolated source mirror is incomplete at $source_dir"
source_id="$(cat "$source_dir/.predex-source-id")"
[[ "$source_id" =~ ^[0-9a-f]{12}-[0-9a-f]{12}$ ]] || fail 'unexpected source id format'
evidence_dir="$remote_root/evidence/$source_id/privy-live"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
export PATH="$toolchain_root/node-v22.19.0-linux-x64/bin:$toolchain_root/bun-v1.3.10-baseline/bin:$PATH"
cd "$source_dir"

api_unit=predex-privy-api
api_unit_file="$api_unit.service"
preview_api_url=http://127.0.0.1:3001
api_marker_dir="$remote_root/runtime"
# The isolated root's runtime marker, which sync.sh refuses to sync over. It is
# neither the canonical runtime marker nor qa-stack's source/.qa/active.
api_marker="$api_marker_dir/active"
api_marker_owner=privy-preview-api
node_root="$toolchain_root/node-v22.19.0-linux-x64"

# Checks an API's /config against this source's shared deployment. Only field
# names are reported, never the response body.
api_check='
  (async () => {
    const die = (message) => { console.error(`privy-preview: ${message}`); process.exit(1); };
    const raw = process.env.PREVIEW_API_URL ?? "";
    let url;
    try { url = new URL(raw); } catch { die("PREDEX_PREVIEW_API_URL is not a valid URL"); }
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (/\s/.test(raw) || !(url.protocol === "https:" || (url.protocol === "http:" && loopback))) {
      die("PREDEX_PREVIEW_API_URL must be https:// (or loopback http://) without whitespace");
    }
    if (url.username || url.password || raw.includes("?") || raw.includes("#")) {
      die("PREDEX_PREVIEW_API_URL must not include credentials, query, or fragment");
    }
    const base = url.href.replace(/\/+$/, "");
    const { ARC, ADDRESSES } = await import(`${process.cwd()}/shared/src/addresses.ts`);
    let config;
    try {
      const response = await fetch(`${base}/config`, { signal: AbortSignal.timeout(10_000), redirect: "error" });
      if (!response.ok) die(`GET ${base}/config returned HTTP ${response.status}`);
      config = await response.json();
    } catch (error) {
      die(`GET ${base}/config failed (${error?.name ?? "error"})`);
    }
    const mismatches = [];
    if (config?.chainId !== ARC.chainId) mismatches.push("chainId");
    for (const field of ["usdc", "ctf", "oracle", "lmsr", "registry", "miniClob"]) {
      const live = config?.addresses?.[field];
      if (typeof live !== "string" || live.toLowerCase() !== ADDRESSES[field].toLowerCase()) {
        mismatches.push(`addresses.${field}`);
      }
    }
    if (mismatches.length > 0) {
      die(`API ${base} serves a different deployment; mismatched: ${mismatches.join(", ")}`);
    }
    process.stdout.write(base);
  })();
'

unit_property() {
  systemctl --user show --property="$1" --value "$api_unit_file" 2>/dev/null || true
}

marker_is_ours() {
  [[ -f "$api_marker" && ! -L "$api_marker" ]] &&
    grep -Fxq "owner=$api_marker_owner" "$api_marker" &&
    grep -Fxq "unit=$api_unit_file" "$api_marker"
}

require_verified_backend() {
  local manifest="$remote_root/evidence/$source_id/manifest.txt" gate
  [[ -f "$manifest" && ! -L "$manifest" ]] ||
    fail "verification manifest is missing for source $source_id"
  grep -Fxq "source_id=$source_id" "$manifest" ||
    fail 'verification manifest belongs to a different source'
  for gate in backend_typecheck backend_build backend_test; do
    grep -Fxq "$gate=pass" "$manifest" || fail "verification manifest is not passing: $gate"
  done
  grep -Eq '^finished_at=[0-9]{4}-[0-9]{2}-[0-9]{2}T' "$manifest" ||
    fail 'verification manifest has no completion timestamp'
  [[ -x "$node_root/bin/node" && -x "$node_root/bin/pnpm" ]] ||
    fail 'the pinned Node.js toolchain is unavailable'
  [[ -x "$source_dir/backend/node_modules/.bin/tsx" ]] ||
    fail 'backend dependencies are unavailable'
  "$node_root/bin/node" -e '
    const scripts = require(process.argv[1]).scripts ?? {};
    process.exit(scripts.api === "tsx src/api.ts" ? 0 : 1);
  ' "$source_dir/backend/package.json" ||
    fail 'backend api script is not the API-only entry (tsx src/api.ts)'
}

case "$command_name" in
  up)
    app_id="$1"
    client_id="$2"
    api_url="$3"
    command -v bun >/dev/null 2>&1 || fail 'pinned Bun is missing; run scripts/cloudlab/bootstrap-browse.sh'
    # Refuse any API whose deployment differs from this source before anything is
    # recorded or started.
    remote_api="$(PREVIEW_API_URL="$api_url" bun --eval "$api_check")" ||
      fail 'refusing to start preview: API deployment check failed'

    mkdir -p "$evidence_dir"
    {
      printf 'source_id=%s\nhost=%s\nstarted_at=%s\n' \
        "$source_id" "$(hostname)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      printf 'preview=development (next dev via qa-stack --external-wallet); not a production build\n'
      printf 'remote_api=%s\nfrontend_url=%s\nnode=%s\n' "$remote_api" "$frontend_url" "$(node --version)"
      printf 'api_deployment_check=pass (chainId + usdc/ctf/oracle/lmsr/registry/miniClob match shared ADDRESSES)\n'
      printf 'NEXT_PUBLIC_PRIVY_APP_ID=%s\nNEXT_PUBLIC_PRIVY_CLIENT_ID=%s\n' "$app_id" "${client_id:-<unset>}"
    } > "$evidence_dir/config-$stamp.txt"

    export NEXT_PUBLIC_PRIVY_APP_ID="$app_id"
    if [[ -n "$client_id" ]]; then
      export NEXT_PUBLIC_PRIVY_CLIENT_ID="$client_id"
    else
      unset NEXT_PUBLIC_PRIVY_CLIENT_ID
    fi
    status=0
    bash "$qa_stack" up --external-wallet --remote-api "$remote_api" < /dev/null 2>&1 |
      tee "$evidence_dir/qa-stack-up-$stamp.log" || status=$?
    if [[ -f .qa/logs/frontend.log ]]; then
      cp .qa/logs/frontend.log "$evidence_dir/frontend-startup-$stamp.log"
    fi
    printf 'source_id=%s\nevidence=%s\n' "$source_id" "$evidence_dir"
    exit "$status"
    ;;
  down)
    mkdir -p "$evidence_dir"
    bash "$qa_stack" down < /dev/null 2>&1 | tee "$evidence_dir/qa-stack-down-$stamp.log"
    printf 'source_id=%s\n' "$source_id"
    ;;
  api-up)
    command -v bun >/dev/null 2>&1 || fail 'pinned Bun is missing; run scripts/cloudlab/bootstrap-browse.sh'
    command -v systemd-run >/dev/null 2>&1 || fail 'systemd-run is unavailable'
    command -v ss >/dev/null 2>&1 || fail 'ss is unavailable'
    require_verified_backend
    if [[ -e "$api_marker" || -L "$api_marker" ]]; then
      if marker_is_ours; then
        fail "API preview marker already exists at $api_marker; check status, then api-down"
      fi
      fail "refusing foreign or unreadable marker at $api_marker; leaving it untouched"
    fi
    unit_load="$(unit_property LoadState)"
    [[ "$unit_load" == not-found ]] ||
      fail "$api_unit_file already exists (load=${unit_load:-unknown} active=$(unit_property ActiveState)); reporting it instead of replacing it"
    for unit in predex-indexer.service predex-operator.service; do
      if systemctl --user is-active --quiet "$unit"; then
        fail "canonical $unit is active; refusing to start the API preview"
      fi
    done
    listeners="$(ss -H -ltn 'sport = :3001')" || fail 'could not inspect TCP listeners'
    [[ -z "$listeners" ]] || fail 'TCP port 3001 is already occupied'

    mkdir -p "$api_marker_dir" "$evidence_dir"
    chmod 700 "$api_marker_dir"
    marker_tmp="$(mktemp "$api_marker_dir/.active.XXXXXX")"
    chmod 600 "$marker_tmp"
    printf 'owner=%s\nunit=%s\nsource_id=%s\napi_url=%s\nstarted_at=%s\n' \
      "$api_marker_owner" "$api_unit_file" "$source_id" "$preview_api_url" \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$marker_tmp"
    # A hard link never replaces a marker that appeared since the check above.
    if ! ln "$marker_tmp" "$api_marker" 2>/dev/null; then
      rm -f "$marker_tmp"
      fail "a marker appeared at $api_marker; leaving it untouched"
    fi
    rm -f "$marker_tmp"

    unit_created=false
    start_epoch="$(date +%s)"
    # Stops only the unit this invocation created and removes only its own
    # marker; databases are never touched.
    abort_api_up() {
      trap - HUP INT TERM
      if [[ "$unit_created" == true ]]; then
        journalctl --user --unit="$api_unit_file" --since="@$start_epoch" --no-pager --output=cat \
          > "$evidence_dir/api-up-failure-$stamp.log" 2>&1 || true
        systemctl --user stop "$api_unit_file" >/dev/null 2>&1 ||
          fail "API cleanup could not stop its unit; keeping $api_marker to protect the source"
      elif [[ "$(unit_property LoadState)" != not-found ]]; then
        fail "API unit creation is ambiguous; keeping $api_marker for inspection"
      fi
      if marker_is_ours && grep -Fxq "source_id=$source_id" "$api_marker"; then
        rm -f "$api_marker"
      fi
      fail "$1"
    }
    trap 'abort_api_up "interrupted while starting the API preview"' HUP INT TERM

    {
      printf 'source_id=%s\nhost=%s\nstarted_at=%s\n' \
        "$source_id" "$(hostname)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      printf 'unit=%s\napi_url=%s\nmarker=%s\nnode=%s\n' \
        "$api_unit_file" "$preview_api_url" "$api_marker" "$("$node_root/bin/node" --version)"
      printf 'entry=pnpm api (backend/src/api.ts); indexer and operator are not started\n'
    } > "$evidence_dir/api-up-$stamp.txt"

    # Secrets are blanked rather than inherited from the user manager, and
    # backend/.env is never read.
    if ! systemd-run --user --unit="$api_unit" --collect --quiet \
      --property=Type=exec \
      --property=Restart=on-failure \
      --property=RestartSec=5 \
      --property=KillMode=control-group \
      --property=UMask=0077 \
      --property=WorkingDirectory="$source_dir/backend" \
      --setenv=PATH="$node_root/bin:/usr/local/bin:/usr/bin:/bin" \
      --setenv=DOTENV_CONFIG_PATH=/dev/null \
      --setenv=NODE_ENV=production \
      --setenv=API_HOST=127.0.0.1 \
      --setenv=API_PORT=3001 \
      --setenv=DATABASE_URL='postgresql://predex:predex@127.0.0.1:5432/predex_pump?schema=public' \
      --setenv=DATABASE_POOL_SIZE=8 \
      --setenv=REDIS_URL=redis://127.0.0.1:6379 \
      --setenv=REDIS_KEY_PREFIX=predex-privy-preview \
      --setenv=QDRANT_URL=http://127.0.0.1:6333 \
      --setenv=PREDEX_WEB_ORIGIN=http://127.0.0.1:3002 \
      --setenv=SIWE_DOMAIN=127.0.0.1:3002 \
      --setenv=SIWE_URI=http://127.0.0.1:3002 \
      --setenv=ACCOUNT_COOKIE_SECURE=false \
      --setenv=ACCOUNT_COOKIE_SAMESITE=Lax \
      --setenv=ACCOUNT_COOKIE_PATH=/ \
      --setenv=PREDEX_TRUTH_SELLER_MODE=disabled \
      --setenv=OPENAI_API_KEY= \
      --setenv=OPERATOR_PRIVATE_KEY= \
      --setenv=QA_WALLET_PRIVATE_KEY= \
      "$node_root/bin/pnpm" api; then
      abort_api_up "systemd-run could not start $api_unit_file"
    fi
    unit_created=true

    # A stale indexer is expected for this snapshot; only HTTP 200 is required.
    api_health=000
    for _ in $(seq 1 60); do
      api_health="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$preview_api_url/health" 2>/dev/null || true)"
      [[ "$api_health" == 200 ]] && break
      [[ "$(unit_property LoadState)" == not-found ]] && break
      sleep 2
    done
    [[ "$api_health" == 200 ]] ||
      abort_api_up "GET $preview_api_url/health did not return HTTP 200 within 120s (last: ${api_health:-000})"
    PREVIEW_API_URL="$preview_api_url" bun --eval "$api_check" >/dev/null ||
      abort_api_up "$preview_api_url/config does not match this source's deployment"
    trap - HUP INT TERM

    {
      printf 'api_health_http_status=%s\n' "$api_health"
      printf 'api_deployment_check=pass (chainId + usdc/ctf/oracle/lmsr/registry/miniClob match shared ADDRESSES)\n'
      for unit in predex-indexer.service predex-operator.service; do
        printf '%s=%s\n' "$unit" "$(systemctl --user is-active "$unit" 2>/dev/null || true)"
      done
    } | tee -a "$evidence_dir/api-up-$stamp.txt"
    printf 'source_id=%s\nunit=%s\napi_url=%s\nevidence=%s\n' \
      "$source_id" "$api_unit_file" "$preview_api_url" "$evidence_dir"
    printf 'frontend: PREDEX_PREVIEW_API_URL=%s NEXT_PUBLIC_PRIVY_APP_ID=<public id> scripts/cloudlab/privy-preview.sh up\n' \
      "$preview_api_url"
    ;;
  api-down)
    unit_load="$(unit_property LoadState)"
    if [[ ! -e "$api_marker" && ! -L "$api_marker" ]]; then
      [[ "$unit_load" == not-found ]] ||
        fail "$api_unit_file exists (load=${unit_load:-unknown}) without this preview's marker; reporting it instead of stopping it"
      printf 'source_id=%s\napi_preview=not running\n' "$source_id"
      exit 0
    fi
    marker_is_ours ||
      fail "$api_marker is not owned by the API preview; leaving it untouched"
    grep -Fxq "source_id=$source_id" "$api_marker" ||
      fail "API preview marker records a source other than $source_id; leaving it untouched"
    if [[ "$unit_load" != not-found ]]; then
      [[ "$(unit_property WorkingDirectory)" == "$source_dir/backend" ]] ||
        fail "$api_unit_file does not run from $source_dir/backend; leaving it untouched"
      [[ "$(unit_property ExecStart)" == *"argv[]=$node_root/bin/pnpm api ;"* ]] ||
        fail "$api_unit_file does not run the pinned pnpm api entry; leaving it untouched"
    fi
    if [[ -e "$source_dir/.qa/active" ]]; then
      printf 'privy-preview: the frontend preview stays up and loses its API; stop it with `privy-preview.sh down`, preferably before api-down\n' >&2
    fi
    mkdir -p "$evidence_dir"
    if [[ "$unit_load" == not-found ]]; then
      printf 'privy-preview: %s is already gone; removing only its stale marker\n' "$api_unit_file" >&2
    else
      systemctl --user stop "$api_unit_file"
    fi
    if systemctl --user is-active --quiet "$api_unit_file"; then
      fail "$api_unit_file is still active; keeping $api_marker"
    fi
    rm -f "$api_marker"
    printf 'source_id=%s\nunit=%s\nstopped_at=%s\n' \
      "$source_id" "$api_unit_file" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" |
      tee "$evidence_dir/api-down-$stamp.txt"
    ;;
  status)
    http_status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$frontend_url/" 2>/dev/null || true)"
    printf 'source_id=%s\nfrontend_http_status=%s\n' "$source_id" "${http_status:-000}"
    if [[ -e .qa/active ]]; then
      printf 'qa_active=yes\n'
    else
      printf 'qa_active=no\n'
    fi
    for name in wallet backend frontend; do
      [[ -f ".qa/$name.pid" ]] || continue
      pid="$(head -n 1 ".qa/$name.pid")"
      running=no
      [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null && running=yes
      printf '%s_pid=%s running=%s\n' "$name" "$pid" "$running"
    done
    latest_config="$(ls -1t "$evidence_dir"/config-*.txt 2>/dev/null | head -n 1 || true)"
    printf 'latest_config=%s\n' "${latest_config:-<none>}"
    api_http_status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$preview_api_url/health" 2>/dev/null || true)"
    printf 'api_url=%s\napi_http_status=%s\n' "$preview_api_url" "${api_http_status:-000}"
    unit_load="$(unit_property LoadState)"
    unit_active="$(unit_property ActiveState)"
    printf 'api_unit=%s load=%s active=%s\n' "$api_unit_file" "${unit_load:-unknown}" "${unit_active:-unknown}"
    if [[ ! -e "$api_marker" && ! -L "$api_marker" ]]; then
      printf 'api_marker=absent\n'
    elif marker_is_ours; then
      printf 'api_marker=privy-preview-api %s\n' "$(grep -m 1 '^source_id=' "$api_marker" || true)"
    else
      printf 'api_marker=foreign\n'
    fi
    ;;
  browse)
    [[ -x "$browse_bin" ]] || fail 'pinned browse is missing; run scripts/cloudlab/bootstrap-browse.sh'
    printf 'source_id=%s\n' "$source_id" >&2
    # Pin daemon state inside the isolated source rather than relying on git root discovery.
    export BROWSE_STATE_FILE="$source_dir/.gstack/browse.json"
    exec "$browse_bin" "$@"
    ;;
  *)
    fail "unknown command: $command_name"
    ;;
esac
REMOTE

encoded_script="$(printf '%s\n' "$remote_script" | base64 | tr -d '\n')"
remote_command="bash -c \"\$(printf %s $encoded_script | base64 -d)\" privy-preview"
remote_command+=" $(sq "$CLOUDLAB_REMOTE_ROOT")"
for arg in "${remote_args[@]}"; do
  remote_command+=" $(sq "$arg")"
done

ssh_args=(
  -i "$CLOUDLAB_IDENTITY_FILE"
  -o BatchMode=yes
  -o ConnectTimeout=12
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=4
)

if [[ "$1" == browse ]]; then
  # Keep local stdin attached so `browse chain` can read its JSON.
  ssh "${ssh_args[@]}" "$CLOUDLAB_HOST" "$remote_command"
else
  ssh -n "${ssh_args[@]}" "$CLOUDLAB_HOST" "$remote_command"
fi
