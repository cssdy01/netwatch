#!/bin/bash
# =============================================================================
# 2_precheck.sh — Pre-flight checks before starting NetWatch containers.
# Run after docker load, before 3_run.sh.
# Usage: bash 2_precheck.sh
# =============================================================================

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
PASS=0; FAIL=0; WARN=0

pass() { echo -e "  ${GREEN}[PASS]${NC} $1"; ((PASS++)); }
fail() { echo -e "  ${RED}[FAIL]${NC} $1"; ((FAIL++)); }
warn() { echo -e "  ${YELLOW}[WARN]${NC} $1"; ((WARN++)); }
info() { echo -e "  ${CYAN}[INFO]${NC} $1"; }

echo ""
echo "============================================================"
echo "  NetWatch — Pre-flight Check"
echo "============================================================"

# ── SECTION 1: Host requirements ─────────────────────────────────────────────
echo ""
echo "[ Host ]"

# Docker
if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
  pass "Docker is running: $(docker --version | awk '{print $3}' | tr -d ',')"
else
  fail "Docker is not running. Run: sudo systemctl start docker"
fi

# Docker group
if groups "$(whoami)" | grep -q docker; then
  pass "User '$(whoami)' is in the docker group."
else
  warn "User '$(whoami)' not in docker group — sudo required for docker commands."
fi

# Port 80
if ss -tlnp 2>/dev/null | grep -q ':80 '; then
  HOLDER=$(ss -tlnp 2>/dev/null | grep ':80 ' | awk '{print $7}' | head -1)
  if echo "$HOLDER" | grep -q "netwatch-frontend"; then
    pass "Port 80 is in use by netwatch-frontend."
  else
    fail "Port 80 is already in use by: ${HOLDER}. Stop it or change FRONTEND_PORT in 3_run.sh."
  fi
else
  pass "Port 80 is free."
fi

# Port 3000
if ss -tlnp 2>/dev/null | grep -q ':3000 '; then
  HOLDER=$(ss -tlnp 2>/dev/null | grep ':3000 ' | awk '{print $7}' | head -1)
  if echo "$HOLDER" | grep -q "netwatch-backend"; then
    pass "Port 3000 is in use by netwatch-backend."
  else
    fail "Port 3000 is already in use by: ${HOLDER}. Stop it or change BACKEND_PORT in 3_run.sh."
  fi
else
  pass "Port 3000 is free."
fi

# ── SECTION 2: Docker images ──────────────────────────────────────────────────
echo ""
echo "[ Docker Images ]"

if docker image inspect netwatch-backend:latest &>/dev/null 2>&1; then
  SIZE=$(docker image inspect netwatch-backend:latest --format='{{.Size}}' | awk '{printf "%.0f MB", $1/1048576}')
  CREATED=$(docker image inspect netwatch-backend:latest --format='{{.Created}}' | cut -c1-10)
  pass "netwatch-backend:latest found — ${SIZE}, created ${CREATED}"
else
  fail "netwatch-backend:latest not found. Load it: docker load -i netwatch-backend.tar"
fi

if docker image inspect netwatch-frontend:latest &>/dev/null 2>&1; then
  SIZE=$(docker image inspect netwatch-frontend:latest --format='{{.Size}}' | awk '{printf "%.0f MB", $1/1048576}')
  CREATED=$(docker image inspect netwatch-frontend:latest --format='{{.Created}}' | cut -c1-10)
  pass "netwatch-frontend:latest found — ${SIZE}, created ${CREATED}"
else
  fail "netwatch-frontend:latest not found. Load it: docker load -i netwatch-frontend.tar"
fi

# ── SECTION 3: Existing containers ───────────────────────────────────────────
echo ""
echo "[ Containers ]"

BACKEND_STATE=$(docker inspect netwatch-backend --format='{{.State.Status}}' 2>/dev/null || echo "not found")
FRONTEND_STATE=$(docker inspect netwatch-frontend --format='{{.State.Status}}' 2>/dev/null || echo "not found")

case "$BACKEND_STATE" in
  running)  pass  "netwatch-backend is running." ;;
  exited)   warn  "netwatch-backend exists but is stopped. 3_run.sh will restart it." ;;
  "not found") info "netwatch-backend does not exist yet — will be created by 3_run.sh." ;;
  *)        warn  "netwatch-backend state: ${BACKEND_STATE}" ;;
esac

case "$FRONTEND_STATE" in
  running)  pass  "netwatch-frontend is running." ;;
  exited)   warn  "netwatch-frontend exists but is stopped. 3_run.sh will restart it." ;;
  "not found") info "netwatch-frontend does not exist yet — will be created by 3_run.sh." ;;
  *)        warn  "netwatch-frontend state: ${FRONTEND_STATE}" ;;
esac

# ── SECTION 4: Postfix (mail relay) ──────────────────────────────────────────
echo ""
echo "[ Mail / Postfix ]"

if systemctl is-active --quiet postfix 2>/dev/null; then
  pass "Postfix is running on host."
else
  fail "Postfix is NOT running on host. Run: sudo systemctl start postfix"
fi

# Docker bridge gateway
DOCKER_GW=$(docker network inspect bridge 2>/dev/null \
  | grep '"Gateway"' | awk -F'"' '{print $4}' | head -1)
DOCKER_GW="${DOCKER_GW:-172.17.0.1}"
info "Docker bridge gateway: ${DOCKER_GW}"

# mynetworks includes Docker subnet
MYNETWORKS=$(postconf mynetworks 2>/dev/null)
if echo "$MYNETWORKS" | grep -q "172.17"; then
  pass "Postfix mynetworks includes Docker subnet 172.17.0.0/16."
else
  fail "Postfix mynetworks does NOT include Docker subnet."
  fail "  Fix: sudo postconf -e 'mynetworks = 127.0.0.0/8 172.17.0.0/16 [::1]/128' && sudo systemctl reload postfix"
fi

# Port 25 accessible
if command -v nc &>/dev/null; then
  if timeout 3 bash -c "echo QUIT | nc -w 2 ${DOCKER_GW} 25 2>/dev/null" | grep -q "220"; then
    pass "Port 25 on ${DOCKER_GW} is accepting connections."
  else
    fail "Port 25 on ${DOCKER_GW} is not reachable. Check firewall:"
    fail "  sudo firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=172.17.0.0/16 port port=25 protocol=tcp accept'"
    fail "  sudo firewall-cmd --reload"
  fi
else
  warn "nc not installed — cannot test port 25. Install: sudo dnf install -y nc"
fi

# ── SECTION 5: Inside running backend (only if already running) ───────────────
if [ "$BACKEND_STATE" = "running" ]; then
  echo ""
  echo "[ Inside Backend Container ]"

  # Mail binary
  MAIL_BIN=$(docker exec netwatch-backend bash -c \
    "which bsd-mailx 2>/dev/null || which mailx 2>/dev/null || which mail 2>/dev/null || echo ''" 2>/dev/null)
  if [ -n "$MAIL_BIN" ]; then
    pass "Mail binary found: ${MAIL_BIN}"
  else
    fail "No mail binary inside container. Rebuild: docker build --no-cache -t netwatch-backend ./backend"
  fi

  # Postfix inside container
  POSTFIX_STATUS=$(docker exec netwatch-backend /usr/sbin/postfix status 2>&1 || echo "not running")
  if echo "$POSTFIX_STATUS" | grep -q "is running"; then
    pass "Postfix inside container is running."
  else
    fail "Postfix inside container is NOT running."
    fail "  Fix: docker exec -it netwatch-backend bash -c '/usr/sbin/postfix start'"
    fail "  Or rebuild the image: docker build --no-cache -t netwatch-backend ./backend"
  fi

  # API health
  API_RESP=$(curl -sf http://localhost:3000/healthz 2>/dev/null || echo "")
  if echo "$API_RESP" | grep -q "ok"; then
    pass "Backend API is responding at :3000/healthz"
  else
    fail "Backend API not responding. Check: docker logs netwatch-backend"
  fi
fi

# ── SECTION 6: Data volume ────────────────────────────────────────────────────
echo ""
echo "[ Data Volume ]"

if docker volume inspect netwatch-data &>/dev/null 2>&1; then
  MOUNT=$(docker volume inspect netwatch-data --format='{{.Mountpoint}}' 2>/dev/null)
  SIZE=$(du -sh "$MOUNT" 2>/dev/null | cut -f1 || echo "unknown")
  pass "Volume 'netwatch-data' exists. Size: ${SIZE}. Path: ${MOUNT}"
else
  info "Volume 'netwatch-data' not created yet — will be created by 3_run.sh on first run."
fi

# ── Final summary ─────────────────────────────────────────────────────────────
echo ""
echo "============================================================"
TOTAL=$((PASS + FAIL + WARN))
echo -e "  Results: ${GREEN}${PASS} passed${NC}  ${RED}${FAIL} failed${NC}  ${YELLOW}${WARN} warnings${NC}  (${TOTAL} checks)"
echo "============================================================"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo -e "  ${RED}Fix the failed checks above before running 3_run.sh.${NC}"
  echo ""
  exit 1
elif [ "$WARN" -gt 0 ]; then
  echo ""
  echo -e "  ${YELLOW}Warnings noted. System can start but review warnings.${NC}"
  echo "  Next: bash 3_run.sh"
  echo ""
  exit 0
else
  echo ""
  echo -e "  ${GREEN}All checks passed. Ready to run.${NC}"
  echo "  Next: bash 3_run.sh"
  echo ""
  exit 0
fi
