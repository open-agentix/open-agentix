#!/usr/bin/env bash
# Smoke test of the run-node-claude-code image (DOG-1, docs/verification/claude-code-harness.md).
# Builds nothing: it inspects the given image in hardened throwaway containers (read-only root,
# cap-drop ALL, no-new-privileges, tmpfs /tmp with noexec,nosuid,nodev, no network, pids/memory limits).
# Checks: pinned `claude --version`, no managed settings, no package manager, no setuid/setgid files,
# uid 10001, minimal writable paths, `claude` runs with a noexec /tmp, no OCI source label, and (unless
# --no-network) isolation on an internal network with a tiny FAKE egress proxy answering 407.
# Usage: scripts/test-harness-image.sh <image> [--no-network]
set -uo pipefail
IMAGE="${1:?usage: test-harness-image.sh <image> [--no-network]}"
NETWORK_TESTS=1
[ "${2:-}" = "--no-network" ] && NETWORK_TESTS=0
cd "$(dirname "$0")/.."
WANT="$(sed -n 's/^ARG CLAUDE_CODE_VERSION=//p' Dockerfile | head -1)"
[ -n "$WANT" ] || { echo "cannot read the pinned version from the Dockerfile" >&2; exit 2; }

FAILS=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAILS=$((FAILS + 1)); }
check() { # check <description> <expected> <actual>
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi
}

# Same hardening as the container runner (packages/runners/src/container.ts, buildCreateBody).
HARDEN=(--rm --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --memory 512m
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777,uid=10001,gid=10001
  --tmpfs /run/oax:rw,noexec,nosuid,nodev,size=1m,mode=0700,uid=10001,gid=10001)
# `docker run` itself can fail on a busy engine ("task ... not found", "ttrpc: closed": containerd race of
# very short-lived containers); such engine errors are retried, test results are never retried.
drun() {
  local out n
  for n in 1 2 3 4 5; do
    out="$(docker run "$@" 2>&1)"
    case "$out" in
      *"task "*"not found"*|*"ttrpc: closed"*|*"failed to create shim task"*) sleep 1 ;;
      *) printf '%s\n' "$out"; return 0 ;;
    esac
  done
  printf '%s\n' "$out"
}
inbox() { drun "${HARDEN[@]}" --network none --entrypoint sh "$IMAGE" -c "$1"; }

# 1. pinned version, exact
VERSION_OUT="$(drun "${HARDEN[@]}" --network none --entrypoint /opt/claude-code/bin/claude "$IMAGE" --version 2>&1)"
check "claude --version is the pinned version (noexec /tmp, read-only root)" "${WANT} (Claude Code)" "$VERSION_OUT"
check "image label io.openagentix.claude-code.version" "$WANT" \
  "$(docker image inspect "$IMAGE" --format '{{index .Config.Labels "io.openagentix.claude-code.version"}}')"

# 2. no managed settings / system-wide Claude Code config
check "no /etc/claude-code, no managed-settings.json, no CLAUDE.md in /etc" "" \
  "$(inbox 'ls -d /etc/claude-code 2>/dev/null; find / -xdev \( -name managed-settings.json -o -name managed-mcp.json \) 2>/dev/null; ls /etc/CLAUDE.md /etc/claude-code* 2>/dev/null')"

# 3. no package manager and no installer
check "no apk/yarn/npm/npx/pnpm/corepack/pip/pip3 on PATH or in the usual places" "" \
  "$(inbox 'for c in apk yarn yarnpkg npm npx pnpm corepack pip pip3 curl; do command -v $c; done; ls -d /sbin/apk /etc/apk /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* 2>/dev/null')"

# 4. no setuid / setgid files
# Files only: the node base image sets the setgid bit on a few directories (/usr/local/...), which has no
# effect on execution; they are listed as INFO.
check "no setuid/setgid files (find / -xdev -type f -perm /6000)" "" "$(inbox 'find / -xdev -type f -perm /6000 2>/dev/null')"
echo "INFO  setgid directories (not executable): $(inbox 'find / -xdev -type d -perm /6000 2>/dev/null' | grep -vc "^$") (all under /usr/local, /home/node)"
echo "INFO  busybox applets present as in every Alpine image (no network tools usable offline): $(inbox 'ls /usr/bin/wget 2>/dev/null')"

# 5. runs as uid 10001
check "default user is 10001:10001" "10001:10001" "$(docker image inspect "$IMAGE" --format '{{.Config.User}}')"
check "id -u/-g inside the container" "10001 10001" "$(inbox 'echo $(id -u) $(id -g)')"

# 6. root filesystem: read-only works, writable paths minimal (without --read-only to list them)
check "root filesystem is read-only and /tmp is writable" "ro-ok tmp-ok" \
  "$(inbox 'touch /x 2>/dev/null && echo ro-broken || echo -n "ro-ok "; touch /tmp/x && echo tmp-ok')"
WRITABLE="$(drun --rm --cap-drop ALL --security-opt no-new-privileges --network none --entrypoint sh "$IMAGE" -c \
  'find / -xdev \( -path /proc -o -path /sys -o -path /dev \) -prune -o \( -type f -o -type d \) -exec test -w {} \; -print 2>/dev/null' | sort | tr '\n' ' ')"
echo "INFO  paths writable for uid 10001 on a writable root filesystem: ${WRITABLE:-none}"
EXTRA="$(printf '%s\n' $WRITABLE | grep -vxE '/tmp|/var/tmp|/run/oax' || true)"
check "no writable paths other than /tmp, /var/tmp, /run/oax" "" "$EXTRA"

# 7. no source label (GHCR would link the package to the public repository)
check "no org.opencontainers.image.source label" "" \
  "$(docker image inspect "$IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.source"}}')"

# 8. Claude Code starts with the hardening (noexec /tmp is the runner default): help + doctor-free sanity
HELP="$(drun "${HARDEN[@]}" --network none -e HOME=/tmp -e DISABLE_AUTOUPDATER=1 --entrypoint /opt/claude-code/bin/claude "$IMAGE" --help 2>&1 | head -1)"
case "$HELP" in Usage:*) pass "claude --help runs under noexec /tmp (first line: $HELP)";; *) fail "claude --help under noexec /tmp: $HELP";; esac
check "git is present and offline-capable" "ok" "$(inbox 'git --version >/dev/null && echo ok')"

# 9. isolation on an internal network with a fake egress proxy (407 without grant)
if [ "$NETWORK_TESTS" = 1 ]; then
  NET="oax-smoke-$$"
  PROXY="oax-smoke-proxy-$$"
  cleanup() { docker rm -f "$PROXY" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; }
  trap cleanup EXIT
  docker network create --internal "$NET" >/dev/null || { fail "cannot create the internal network"; NETWORK_TESTS=0; }
fi
if [ "$NETWORK_TESTS" = 1 ]; then
  # FAKE proxy (not the real egress proxy): CONNECT without the expected Proxy-Authorization -> 407.
  docker run -d --name "$PROXY" --network "$NET" --read-only --cap-drop ALL --security-opt no-new-privileges \
    --entrypoint node "$IMAGE" -e '
    require("net").createServer((s)=>{let b="";s.on("data",(d)=>{b+=d;if(b.includes("\r\n\r\n")){
      const ok=/proxy-authorization: Bearer grant-ok/i.test(b);
      s.end(ok?"HTTP/1.1 200 Connection established\r\n\r\n":"HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Bearer\r\n\r\n");}});}).listen(3128);' >/dev/null
  sleep 1
  probe() { # probe <js>
    drun "${HARDEN[@]}" --network "$NET" --entrypoint node "$IMAGE" -e "$1" 2>&1
  }
  CONNECT='const s=require("net").connect(3128,"'"$PROXY"'",()=>s.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n"+(process.env.H?"Proxy-Authorization: "+process.env.H+"\r\n":"")+"\r\n"));s.on("data",(d)=>{console.log(String(d).split(" ")[1]);s.destroy()});s.on("error",(e)=>console.log("error "+e.code));setTimeout(()=>process.exit(),4000)'
  check "node network: CONNECT through the proxy without a grant -> 407" "407" \
    "$(drun "${HARDEN[@]}" --network "$NET" --entrypoint node "$IMAGE" -e "$CONNECT")"
  check "node network: CONNECT with a (fake) valid grant -> 200" "200" \
    "$(drun "${HARDEN[@]}" --network "$NET" -e 'H=Bearer grant-ok' --entrypoint node "$IMAGE" -e "$CONNECT")"
  check "node network: public name does not resolve (no DNS to the outside)" "dns-fail" \
    "$(probe 'require("dns").lookup("example.com",(e)=>{console.log(e?"dns-fail":"dns-ok");process.exit()});setTimeout(()=>{console.log("dns-fail");process.exit()},5000)')"
  check "node network: direct connection to a public IP fails (no route)" "blocked" \
    "$(probe 'const s=require("net").connect({host:"1.1.1.1",port:443,timeout:4000},()=>{console.log("REACHED");process.exit()});s.on("error",()=>{console.log("blocked");process.exit()});s.on("timeout",()=>{console.log("blocked");process.exit()})')"
fi

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED for $IMAGE"; else echo "$FAILS CHECK(S) FAILED for $IMAGE"; exit 1; fi
