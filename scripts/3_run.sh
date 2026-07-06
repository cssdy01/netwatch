#!/bin/bash
# =============================================================================
# 3_run.sh — NetWatch container launcher and management console
# =============================================================================

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'
BOLD='\033[1m'; NC='\033[0m'

# =============================================================================
# CONFIG — edit this section
# =============================================================================

MONITOR_HOST=$(hostname -I | awk '{print $1}')
if [ -z "$MONITOR_HOST" ]; then
  MONITOR_HOST="127.0.0.1" # Handle fallback for local Windows environments
fi

BACKEND_PORT=3000
FRONTEND_PORT=8888

ADMIN_USER="admin"
ADMIN_PASS="admin123"
JWT_SECRET="qXbBPAy54peJ1xjBvigKYS4ZeDO6mQXR"
SESSION_HOURS="8"

MAIL_FROM_NAME="NetWatch Monitor"
MAIL_FROM_EMAIL="your.email@company.com"

# Direct SMTP Destination Profiles
SMTP_HOST="smtp.office365.com"
SMTP_PORT="587"
SMTP_USER="your.email@company.com"
SMTP_PASS="YOUR_16_CHAR_APP_PASSWORD"

DEFAULT_N_THRESHOLD="2"
MIN_MONITOR_INTERVAL_MIN="3"
MAX_MONITOR_INTERVAL_MIN="15"
LOG_ARCHIVE_DIR="/app/data/log-archives"
DATA_DIR="/app/data"

DATA_VOLUME="netwatch-data"
BACKEND_IMAGE="netwatch-backend"
FRONTEND_IMAGE="netwatch-frontend"

# =============================================================================
# END CONFIG
# =============================================================================

BACKEND_API_URL="http://${MONITOR_HOST}:${BACKEND_PORT}"

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
    ok=0
  fi
  if ! docker image inspect "${FRONTEND_IMAGE}:latest" &>/dev/null; then
    echo -e "  ${RED}[ERROR]${NC} Image '${FRONTEND_IMAGE}' not found."
    ok=0
  fi
  [ "$ok" -eq 1 ]
}

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
    -e SMTP_HOST="${SMTP_HOST}" \
    -e SMTP_PORT="${SMTP_PORT}" \
    -e SMTP_USER="${SMTP_USER}" \
    -e SMTP_PASS="${SMTP_PASS}" \
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

  if curl -sf "http://localhost:${BACKEND_PORT}/healthz" &>/dev/null; then
    echo -e "  ${GREEN}[OK]${NC} Backend API is responding."
  else
    echo -e "  ${YELLOW}[WARN]${NC} Backend not responding yet — check logs: docker logs netwatch-backend"
  fi
}

do_stop() {
  echo "  Stopping containers..."
  docker stop netwatch-backend netwatch-frontend 2>/dev/null && echo -e "  ${GREEN}Stopped.${NC}" || echo "  Nothing was running."
}

do_restart() {
  echo "  Restarting containers..."
  docker restart netwatch-backend netwatch-frontend 2>/dev/null && echo -e "  ${GREEN}Restarted.${NC}" || echo "  Containers not found."
}

do_logs() {
  docker logs -f --tail 50 netwatch-backend
}

do_mail_check() {
  echo ""
  echo "  --- Direct SMTP Transport Status ---"
  echo "  Relay Endpoint : ${SMTP_HOST}:${SMTP_PORT}"
  echo "  Routing User   : ${SMTP_USER}"
  echo ""
  echo "  Checking backend container runtime environment parameters:"
  docker exec netwatch-backend env | grep -E "SMTP_|MAIL_" || echo "Container not active."
}

do_mail_test() {
  echo ""
  read -rp "  Recipient email address: " ADDR
  [ -z "$ADDR" ] && { echo "  Cancelled."; return; }

  echo "  Triggering local test mail via internal route..."
  # Use curl directly against the internal API loop to verify Nodemailer integration e2e
  docker exec netwatch-backend curl -s -X POST http://localhost:3000/api/logs/test-email \
    -H "Content-Type: application/json" \
    -d "{\"to\":\"${ADDR}\"}" || echo "Trigger failed. Ensure backend container is running and authenticated."
}

do_shell() {
  docker exec -it netwatch-backend bash
}

do_backup_db() {
  DATE=$(date +%Y-%m-%d_%H%M)
  FILE="netwatch-db-${DATE}.db"
  docker cp netwatch-backend:/app/data/netwatch.db "./${FILE}" && echo -e "  ${GREEN}Saved: ./${FILE}${NC}"
}

do_restore_db() {
  read -rp "  Path to .db file to restore: " FILE
  docker stop netwatch-backend 2>/dev/null || true
  docker cp "${FILE}" netwatch-backend:/app/data/netwatch.db
  docker start netwatch-backend
}

do_log_archives() {
  docker exec netwatch-backend ls -lh "${LOG_ARCHIVE_DIR}" 2>/dev/null || echo "No archives yet."
}

do_remove() {
  docker rm -f netwatch-backend netwatch-frontend 2>/dev/null && echo "Containers removed."
}

do_wipe() {
  docker rm -f netwatch-backend netwatch-frontend 2>/dev/null || true
  docker rmi netwatch-backend netwatch-frontend 2>/dev/null || true
  docker volume rm netwatch-data 2>/dev/null || true
}

do_rebuild() {
  docker rm -f netwatch-backend netwatch-frontend 2>/dev/null || true
  echo "  Building fresh backend image..."
  docker build -t netwatch-backend ./backend
  echo "  Building frontend image..."
  docker build -t netwatch-frontend ./frontend
}

do_export_images() {
  docker save netwatch-backend:latest -o ./netwatch-backend.tar
  docker save netwatch-frontend:latest -o ./netwatch-frontend.tar
}

while true; do
  clear
  header "NetWatch — Management Console (SMTP Upgraded)"
  show_status
  echo -e "  ${BOLD}Container${NC}"
  echo "   1) Start           — remove old containers and start fresh"
  echo "   2) Stop"
  echo "   3) Restart"
  echo "   4) View Logs"
  echo ""
  echo -e "  ${BOLD}Mail${NC}"
  echo "   5) Mail Check      — check SMTP environment config"
  echo "   6) Mail Test       — send a test alert via Nodemailer engine"
  echo ""
  echo -e "  ${BOLD}Shell & Data${NC}"
  echo "   7) Open Shell"
  echo "   8) Backup Database"
  echo "   9) Restore Database"
  echo "  14) Log Archives"
  echo ""
  echo -e "  ${BOLD}Images${NC}"
  echo "  10) Build Images    — compile locally from source"
  echo "  11) Export Images   — create .tar artifacts"
  echo ""
  echo -e "  ${BOLD}Cleanup${NC}"
  echo "  12) Remove Containers"
  echo "  13) Full Wipe"
  echo ""
  echo "   0) Exit"
  echo ""
  read -rp "  Choose [0-14]: " choice
  case "$choice" in
    1) do_start ;; 2) do_stop ;; 3) do_restart ;; 4) do_logs ;;
    5) do_mail_check ;; 6) do_mail_test ;; 7) do_shell ;;
    8) do_backup_db ;; 9) do_restore_db ;; 10) do_rebuild ;;
    11) do_export_images ;; 12) do_remove ;; 13) do_wipe ;; 14) do_log_archives ;;
    0) exit 0 ;;
  esac
  read -rp "  Press Enter to return..." _dummy
done