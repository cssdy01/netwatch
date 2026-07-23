#!/bin/bash
# =============================================================================
# 1_setup.sh — System setup for Oracle Linux 8
# Installs Docker, Postfix, configures everything needed to run NetWatch.
# Run once on a fresh Oracle Linux 8 machine.
# Usage: bash 1_setup.sh
# =============================================================================

set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $1"; }
success() { echo -e "${GREEN}[OK]${NC}    $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; }

echo ""
echo "============================================================"
echo "  NetWatch — System Setup for Oracle Linux 8"
echo "============================================================"
echo ""

# ── 1. Remove Podman (conflicts with Docker CE) ───────────────────────────────
info "Checking for Podman conflicts..."
if command -v podman &>/dev/null; then
  warn "Podman detected — removing (conflicts with Docker CE)..."
  sudo dnf remove -y podman buildah skopeo runc podman-docker 2>/dev/null || true
  success "Podman removed."
else
  success "No Podman found."
fi

# ── 2. Install Docker CE 24 ───────────────────────────────────────────────────
info "Checking Docker..."
if command -v docker &>/dev/null && docker --version 2>/dev/null | grep -q "24\."; then
  success "Docker CE 24 already installed: $(docker --version)"
else
  info "Installing Docker CE 24..."
  sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
  sudo dnf install -y \
    docker-ce-24.0.9 \
    docker-ce-cli-24.0.9 \
    containerd.io \
    docker-buildx-plugin \
    docker-compose-plugin \
    --allowerasing
  sudo systemctl enable --now docker
  success "Docker CE 24 installed: $(sudo docker --version)"
fi

# Add current user to docker group
if ! groups "$(whoami)" | grep -q docker; then
  info "Adding $(whoami) to docker group..."
  sudo usermod -aG docker "$(whoami)"
  warn "Group change will apply after re-login. For now, using sudo for docker commands."
  DOCKER_CMD="sudo docker"
else
  DOCKER_CMD="docker"
fi

# ── 3. Install Postfix (host MTA for mail relay) ──────────────────────────────
info "Checking Postfix..."
if ! command -v postfix &>/dev/null; then
  info "Installing Postfix and mailx..."
  sudo dnf install -y postfix mailx
  success "Postfix installed."
else
  success "Postfix already installed: $(postfix -d 2>/dev/null || echo 'installed')"
fi

# Start and enable Postfix
sudo systemctl enable --now postfix
success "Postfix service running."

# ── 4. Configure Postfix to accept relay from Docker containers ───────────────
info "Configuring Postfix for Docker relay..."

# Detect Docker bridge gateway IP
DOCKER_GW=$(${DOCKER_CMD} network inspect bridge 2>/dev/null \
  | grep '"Gateway"' | awk -F'"' '{print $4}' | head -1)
DOCKER_GW="${DOCKER_GW:-172.17.0.1}"
DOCKER_SUBNET="172.17.0.0/16"

info "Docker bridge gateway: ${DOCKER_GW}"

# Allow Docker subnet to relay through this Postfix
sudo postconf -e "mynetworks = 127.0.0.0/8 ${DOCKER_SUBNET} [::1]/128"

# Make sure Postfix listens on all interfaces (not just loopback)
# so containers reaching via gateway IP can connect
CURRENT_INET=$(postconf -h inet_interfaces 2>/dev/null)

if [ "$CURRENT_INET" != "all" ]; then
    info "Setting Postfix inet_interfaces = all (needed for Docker relay)..."
    sudo postconf -e "inet_interfaces = all"
fi

# Apply changes
sudo systemctl reload postfix
success "Postfix configured — relay allowed from ${DOCKER_SUBNET}."

# ── 5. Configure firewall for port 25 from Docker subnet ─────────────────────
info "Checking firewall for port 25..."
if command -v firewall-cmd &>/dev/null && sudo firewall-cmd --state 2>/dev/null | grep -q running; then
  sudo firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=${DOCKER_SUBNET} port port=25 protocol=tcp accept" 2>/dev/null || true
  sudo firewall-cmd --reload 2>/dev/null || true
  success "Firewall: port 25 open for Docker subnet ${DOCKER_SUBNET}."
else
  warn "firewalld not running — skipping firewall configuration."
fi

# ── 6. Verify port 25 reachable from Docker gateway ──────────────────────────
info "Testing port 25 on ${DOCKER_GW}..."
if command -v nc &>/dev/null; then
  if timeout 3 bash -c "echo QUIT | nc -w 2 ${DOCKER_GW} 25 2>/dev/null" | grep -q "220"; then
    success "Port 25 on ${DOCKER_GW} is accepting connections."
  else
    warn "Port 25 test inconclusive. If mail fails, check: telnet ${DOCKER_GW} 25"
  fi
else
  warn "nc not found — skipping port 25 test. Install: sudo dnf install -y nc"
fi

# ── 7. Summary ────────────────────────────────────────────────────────────────
echo ""
echo "============================================================"
echo "  Setup Complete"
echo "============================================================"
success "Docker:  $(${DOCKER_CMD} --version 2>/dev/null | head -1)"
success "Postfix: running"
success "Relay:   Docker containers can relay mail via ${DOCKER_GW}:25"
echo ""
echo "  POSTFIX_RELAY to use in 3_run.sh:"
echo -e "  ${YELLOW}POSTFIX_RELAY=\"${DOCKER_GW}:25\"${NC}"
echo ""
echo "  Next steps:"
echo "  1. Load images:  docker load -i netwatch-backend.tar"
echo "                   docker load -i netwatch-frontend.tar"
echo "  2. Pre-check:    bash 2_precheck.sh"
echo "  3. Run:          bash 3_run.sh"
echo ""
if ! groups "$(whoami)" | grep -q docker; then
  warn "REMINDER: Log out and back in (or run 'newgrp docker') to use Docker without sudo."
fi
