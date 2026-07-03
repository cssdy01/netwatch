#!/bin/bash
# =============================================================================
# 3_run.sh — NetWatch container launcher and management console
# Phase 1 additions:
#   - LOG_ARCHIVE_DIR: configurable log archive folder path
#   - Required folder creation before container start
#   - DATA_DIR volume sub-folders created on host before bind-mount
#   - MIN/MAX interval environment variables
# Usage: bash 3_run.sh
# =============================================================================

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'
BOLD='\033[1m'; NC='\033[0m'

# =============================================================================
# CONFIG — edit this section.
# =============================================================================

MONITOR_HOST=$(hostname -I | awk '{print $1}')   # auto-detects your server IP
                                                   # or set manually: "192.168.11.22"
BACKEND_PORT=3000
FRONTEND_PORT=80

ADMIN_USER="admin"
ADMIN_PASS="admin123"

# Minimum 32 characters — change this to your own random string
JWT_SECRET="qXbBPAy54peJ1xjBvigKYS4ZeDO6mQXR"

SESSION_HOURS="8"

MAIL_FROM_NAME="NetWatch Monitor"
MAIL_FROM_EMAIL="alerts@${MONITOR_HOST}.local"

# Docker bridge gateway IP from: docker network inspect bridge | grep Gateway
POSTFIX_RELAY="172.17.0.1:25"

DEFAULT_N_THRESHOLD="2"

# ── Phase 1: Monitoring interval limits ──────────────────────────────────────
# interval_min per task must be between these values (3–15 minutes)
MIN_MONITOR_INTERVAL_MIN="3"
MAX_MONITOR_INTERVAL_MIN="15"

# ── Phase 1: Log archive directory ───────────────────────────────────────────
# End-of-day log archives are written here inside the container.
# This path is inside the Docker volume, so archives persist across restarts.
# Change only if you need a custom path; default is /app/data/log-archives.
LOG_ARCHIVE_DIR="/app/data/log-archives"

# ── Data directory (inside container — maps to Docker volume) ─────────────────
DATA_DIR="/app/data"

DATA_VOLUME="netwatch-data"
BACKEND_IMAGE="netwatch-backend"
FRONTEND_IMAGE="netwatch-frontend"

# =============================================================================
# END CONFIG
# =============================================================================

BACKEND_API_URL="http://${MONITOR_HOST}:${BACKEND_PORT}"

# ── Helpers ───────────────────────────────────────────────────────────────────

header() {
  echo ""
  echo -e "${BOLD}============================================================${NC}"
  echo -e "${BOLD}  $1${NC}"
  echo -e "${BOLD}============================================================${NC}"
}

container_status() {
  local name="$1"
  local state
  state=$(docker inspect "$name" --format='{{.State.Status}}' 2>/dev/null || echo "not found")
  case "$state" in
    running)     echo -e "${GREEN}running${NC}" ;;
    exited)      echo -e "${RED}stopped${NC}" ;;
    "not found") echo -e "${YELLOW}not created${NC}" ;;
    *)           echo -e "${YELLOW}${state}${NC}" ;;
  esac
}

show_status() {
  echo ""
  echo -e "  Backend  : $(container_status netwatch-backend)  | Frontend : $(container_status netwatch-frontend)"
  echo ""
  docker ps --filter "name=netwatch" --format "  {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || true
  echo ""
}

require_images() {
  local ok=1
  if ! docker image inspect "${BACKEND_IMAGE}:latest" &>/dev/null; then
    echo -e "  ${RED}[ERROR]${NC} Image '${BACKEND_IMAGE}' not found."
    echo "  Load:  docker load -i netwatch-backend.tar"
    ok=0
  fi
  if ! docker image inspect "${FRONTEND_IMAGE}:latest" &>/dev/null; then
    echo -e "  ${RED}[ERROR]${NC} Image '${FRONTEND_IMAGE}' not found."
    echo "  Load:  docker load -i netwatch-frontend.tar"
    ok=0
  fi
  [ "$ok" -eq 1 ]
}

# ── Phase 1: Ensure all required directories exist inside the Docker volume ───
# Docker named volumes auto-create but sub-directories must be pre-seeded
# by running a one-shot container or by the entrypoint.
# The entrypoint.sh handles this on first run, but we ensure LOG_ARCHIVE_DIR
# is included in the entrypoint env so the container creates it automatically.

do_start() {
  require_images || return 1

  echo ""
  echo "  Removing old containers..."
  docker rm -f netwatch-backend netwatch-frontend 2>/dev/null || true

  echo "  Starting backend..."
  docker run -d \
    --name netwatch-backend \
    --restart unless-stopped \
    --add-host=host-gateway:host-gateway \
    -p "${BACKEND_PORT}":3000 \
    -e MONITOR_HOST="${MONITOR_HOST}" \
    -e ADMIN_USER="${ADMIN_USER}" \
    -e ADMIN_PASS="${ADMIN_PASS}" \
    -e JWT_SECRET="${JWT_SECRET}" \
    -e SESSION_HOURS="${SESSION_HOURS}" \
    -e MAIL_FROM_NAME="${MAIL_FROM_NAME}" \
    -e MAIL_FROM_EMAIL="${MAIL_FROM_EMAIL}" \
    -e POSTFIX_RELAY="${POSTFIX_RELAY}" \
    -e DEFAULT_N_THRESHOLD="${DEFAULT_N_THRESHOLD}" \
    -e MIN_MONITOR_INTERVAL_MIN="${MIN_MONITOR_INTERVAL_MIN}" \
    -e MAX_MONITOR_INTERVAL_MIN="${MAX_MONITOR_INTERVAL_MIN}" \
    -e DATA_DIR="${DATA_DIR}" \
    -e LOG_ARCHIVE_DIR="${LOG_ARCHIVE_DIR}" \
    -e TZ="Asia/Kolkata" \
    -v "${DATA_VOLUME}":${DATA_DIR} \
    "${BACKEND_IMAGE}"

  echo "  Starting frontend..."
  docker run -d \
    --name netwatch-frontend \
    --restart unless-stopped \
    -p "${FRONTEND_PORT}":80 \
    -e BACKEND_API_URL="${BACKEND_API_URL}" \
    "${FRONTEND_IMAGE}"

  echo ""
  echo "  Waiting for backend to initialise..."
  sleep 5

  # Quick health check
  if curl -sf "http://localhost:${BACKEND_PORT}/healthz" &>/dev/null; then
    echo -e "  ${GREEN}[OK]${NC} Backend API is responding."
  else
    echo -e "  ${YELLOW}[WARN]${NC} Backend not responding yet — check logs: docker logs netwatch-backend"
  fi

  echo ""
  echo -e "  ${GREEN}NetWatch started.${NC}"
  echo ""
  echo "  Dashboard      : http://${MONITOR_HOST}/"
  echo "  Admin          : http://${MONITOR_HOST}/admin/login.html"
  echo "  Health         : http://${MONITOR_HOST}:${BACKEND_PORT}/healthz"
  echo "  Log Archive Dir: ${LOG_ARCHIVE_DIR} (inside container/volume)"
}

do_stop() {
  echo "  Stopping containers..."
  docker stop netwatch-backend netwatch-frontend 2>/dev/null && \
    echo -e "  ${GREEN}Stopped.${NC}" || echo "  Nothing was running."
}

do_restart() {
  echo "  Restarting containers..."
  docker restart netwatch-backend netwatch-frontend 2>/dev/null && \
    echo -e "  ${GREEN}Restarted.${NC}" || echo "  Containers not found — use Start."
}

do_logs() {
  echo ""
  echo "  Showing last 50 lines — press Ctrl+C to exit"
  echo ""
  docker logs -f --tail 50 netwatch-backend
}

do_mail_check() {
  echo ""
  echo "  --- Mail Binary ---"
  MAIL_BIN=$(docker exec netwatch-backend bash -c \
    "which bsd-mailx 2>/dev/null || which mailx 2>/dev/null || which mail 2>/dev/null || echo 'NOT FOUND'" \
    2>/dev/null || echo "container not running")
  echo "  Binary  : ${MAIL_BIN}"

  echo ""
  echo "  --- Postfix Inside Container ---"
  PFX_STATUS=$(docker exec netwatch-backend /usr/sbin/postfix status 2>&1 || echo "not running / container stopped")
  echo "  Status  : ${PFX_STATUS}"

  echo ""
  echo "  --- Postfix Relay Config ---"
  RELAY_CONF=$(docker exec netwatch-backend postconf relayhost 2>/dev/null || echo "cannot read")
  echo "  Relay   : ${RELAY_CONF}"

  echo ""
  echo "  --- Mail Queue ---"
  QUEUE=$(docker exec netwatch-backend mailq 2>/dev/null || echo "cannot check")
  echo "${QUEUE}" | head -20

  echo ""
  echo "  --- Host Postfix ---"
  if systemctl is-active --quiet postfix 2>/dev/null; then
    echo -e "  ${GREEN}Host Postfix is running.${NC}"
    echo "  mynetworks: $(postconf mynetworks 2>/dev/null | awk '{print $3}')"
  else
    echo -e "  ${RED}Host Postfix is NOT running.${NC}  Fix: sudo systemctl start postfix"
  fi
}

do_mail_test() {
  echo ""
  read -rp "  Recipient email address: " ADDR
  [ -z "$ADDR" ] && { echo "  Cancelled."; return; }

  echo ""
  echo -e "  ${YELLOW}About to send a single test email to: ${ADDR}${NC}"
  read -rp "  Confirm send? [y/N] " yn
  [[ "$yn" =~ ^[Yy]$ ]] || { echo "  Cancelled."; return; }

  echo "  Sending test mail to ${ADDR}..."
  docker exec netwatch-backend bash -c \
    "echo 'Hello,

This is a test mail from NetWatch Monitor.

Monitor Host : ${MONITOR_HOST}
Sent At      : $(date)

Regards,
NetWatch Monitor' | mail -s '[NETWATCH] Mail Test' '${ADDR}'"
  echo ""
  echo -e "  ${GREEN}Submitted to Postfix.${NC}"
  echo "  Check delivery: sudo tail -20 /var/log/maillog"
  echo "  Check queue:    Choose option 5 (Mail Check)"
}

do_shell() {
  echo "  Opening shell inside backend container (type 'exit' to return)..."
  docker exec -it netwatch-backend bash
}

do_backup_db() {
  DATE=$(date +%Y-%m-%d_%H%M)
  FILE="netwatch-db-${DATE}.db"
  docker cp netwatch-backend:/app/data/netwatch.db "./${FILE}" && \
    echo -e "  ${GREEN}Saved: ./${FILE}${NC}" || \
    echo -e "  ${RED}Backup failed — is backend container running?${NC}"
}

do_restore_db() {
  echo ""
  read -rp "  Path to .db file to restore: " FILE
  [ -z "$FILE" ] || [ ! -f "$FILE" ] && { echo "  File not found."; return; }
  read -rp "  This will overwrite the current database. Continue? [y/N] " yn
  [[ "$yn" =~ ^[Yy]$ ]] || { echo "  Cancelled."; return; }
  docker stop netwatch-backend 2>/dev/null || true
  docker cp "${FILE}" netwatch-backend:/app/data/netwatch.db
  docker start netwatch-backend
  echo -e "  ${GREEN}Restored from ${FILE} and restarted backend.${NC}"
}

# ── Phase 1: Show log archive status ──────────────────────────────────────────
do_log_archives() {
  echo ""
  echo "  --- Log Archive Directory ---"
  echo "  Container path: ${LOG_ARCHIVE_DIR}"
  echo ""
  echo "  --- Archive Files ---"
  docker exec netwatch-backend bash -c "ls -lh ${LOG_ARCHIVE_DIR} 2>/dev/null || echo '  No archives yet'" 2>/dev/null || \
    echo "  Container not running"
  echo ""
  echo "  To trigger manual archive: POST /api/logs/archives/trigger (from admin UI)"
  echo "  Archives auto-generate daily at 23:58 IST"
}

do_remove() {
  echo ""
  echo -e "  ${YELLOW}This will remove the containers. Data volume is kept.${NC}"
  read -rp "  Remove netwatch-backend and netwatch-frontend? [y/N] " yn
  [[ "$yn" =~ ^[Yy]$ ]] || { echo "  Cancelled."; return; }
  docker rm -f netwatch-backend netwatch-frontend 2>/dev/null || true
  echo -e "  ${GREEN}Containers removed. Volume 'netwatch-data' kept.${NC}"
}

do_wipe() {
  echo ""
  echo -e "  ${RED}WARNING: This deletes containers, images AND all monitoring data.${NC}"
  read -rp "  Are you absolutely sure? Type YES to confirm: " yn
  [ "$yn" = "YES" ] || { echo "  Cancelled."; return; }
  docker rm -f netwatch-backend netwatch-frontend 2>/dev/null || true
  docker rmi netwatch-backend netwatch-frontend 2>/dev/null || true
  docker volume rm netwatch-data 2>/dev/null || true
  echo -e "  ${GREEN}Everything wiped.${NC}"
}

do_rebuild() {
  echo ""
  echo "  This requires the project source (backend/ and frontend/ folders)."
  if [ ! -d "backend" ] || [ ! -d "frontend" ]; then
    echo -e "  ${RED}[ERROR]${NC} backend/ or frontend/ folder not found in current directory."
    echo "  Run this from the project root: cd netwatch && bash scripts/3_run.sh"
    return
  fi
  read -rp "  Build both images now? [y/N] " yn
  [[ "$yn" =~ ^[Yy]$ ]] || { echo "  Cancelled."; return; }
  docker rm -f netwatch-backend netwatch-frontend 2>/dev/null || true
  echo "  Building backend (this takes 2-5 minutes)..."
  docker build -t netwatch-backend ./backend
  echo "  Building frontend..."
  docker build -t netwatch-frontend ./frontend
  echo -e "  ${GREEN}Build complete. Choose Start to run.${NC}"
}

do_export_images() {
  echo ""
  echo "  Exporting images to current directory..."
  docker save netwatch-backend:latest -o ./netwatch-backend.tar
  echo "  Saved: ./netwatch-backend.tar ($(du -sh ./netwatch-backend.tar | cut -f1))"
  docker save netwatch-frontend:latest -o ./netwatch-frontend.tar
  echo "  Saved: ./netwatch-frontend.tar ($(du -sh ./netwatch-frontend.tar | cut -f1))"
  echo ""
  echo "  Transfer to another server:"
  echo "  scp ./netwatch-*.tar oracle@SERVER_IP:/home/oracle/"
  echo "  Then on server: docker load -i netwatch-backend.tar && docker load -i netwatch-frontend.tar"
}

# ── Main menu loop ─────────────────────────────────────────────────────────────

while true; do
  clear
  header "NetWatch — Management Console"

  echo -e "  Server : ${CYAN}${MONITOR_HOST}${NC}  |  Dashboard: ${CYAN}http://${MONITOR_HOST}/${NC}"
  show_status

  echo -e "  ${BOLD}Container${NC}"
  echo "   1) Start           — remove old containers and start fresh"
  echo "   2) Stop            — stop both containers"
  echo "   3) Restart         — restart both containers"
  echo "   4) View Logs       — tail backend logs (Ctrl+C to return)"
  echo ""
  echo -e "  ${BOLD}Mail${NC}"
  echo "   5) Mail Check      — binary, Postfix status, queue, host status"
  echo "   6) Mail Test       — send ONE test email to verify delivery"
  echo ""
  echo -e "  ${BOLD}Shell & Data${NC}"
  echo "   7) Open Shell      — bash inside backend container"
  echo "   8) Backup Database — copy SQLite DB to current folder"
  echo "   9) Restore Database"
  echo "  14) Log Archives    — show archive status and files"
  echo ""
  echo -e "  ${BOLD}Images${NC}"
  echo "  10) Build Images    — build from source (needs backend/ frontend/ folders)"
  echo "  11) Export Images   — save .tar files for transfer to another server"
  echo ""
  echo -e "  ${BOLD}Cleanup${NC}"
  echo "  12) Remove Containers  (keeps data volume)"
  echo "  13) Full Wipe          (removes containers + images + ALL data)"
  echo ""
  echo "   0) Exit"
  echo ""
  read -rp "  Choose [0-14]: " choice
  echo ""

  case "$choice" in
    1)  header "Start";            do_start ;;
    2)  header "Stop";             do_stop ;;
    3)  header "Restart";          do_restart ;;
    4)  header "Logs";             do_logs ;;
    5)  header "Mail Check";       do_mail_check ;;
    6)  header "Mail Test";        do_mail_test ;;
    7)  header "Shell";            do_shell ;;
    8)  header "Backup Database";  do_backup_db ;;
    9)  header "Restore Database"; do_restore_db ;;
    10) header "Build Images";     do_rebuild ;;
    11) header "Export Images";    do_export_images ;;
    12) header "Remove";           do_remove ;;
    13) header "Full Wipe";        do_wipe ;;
    14) header "Log Archives";     do_log_archives ;;
    0)  echo "Bye."; exit 0 ;;
    *)  echo -e "  ${YELLOW}Invalid choice.${NC}" ;;
  esac

  echo ""
  read -rp "  Press Enter to return to menu..." _dummy
done