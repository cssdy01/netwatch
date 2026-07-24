#!/bin/bash
# enable_netwatch_snmp.sh
# Installs and configures Net-SNMP on Oracle Linux 8 for NetWatch.
# Default mode is secure SNMPv3 authPriv with SHA/AES.
# Run as root or with sudo.

set -euo pipefail

CONF="/etc/snmp/snmpd.conf"
HELPER="/usr/local/sbin/netwatch-snmp-extend"
BACKUP_DIR="/etc/snmp/netwatch-backups"

log() { printf '[NetWatch SNMP] %s\n' "$*"; }
fail() { printf '[NetWatch SNMP] ERROR: %s\n' "$*" >&2; exit 1; }

if [ "${EUID}" -ne 0 ]; then
  fail "Run as root: sudo bash $0"
fi

if ! grep -qE 'Oracle Linux|Red Hat Enterprise Linux|Rocky Linux|AlmaLinux' /etc/os-release; then
  log "Warning: this script is designed for Oracle Linux/RHEL-compatible systems."
fi

read -rp "NetWatch monitoring server IPv4/CIDR (example 192.168.1.20/32): " MONITOR_CIDR
[ -n "$MONITOR_CIDR" ] || fail "Monitoring server CIDR is required"

read -rp "SNMPv3 username [netwatch]: " SNMP_USER
SNMP_USER="${SNMP_USER:-netwatch}"

read -rsp "SNMPv3 authentication password (minimum 8 characters): " AUTH_PASS
echo
[ ${#AUTH_PASS} -ge 8 ] || fail "Authentication password must contain at least 8 characters"

read -rsp "SNMPv3 privacy password (minimum 8 characters): " PRIV_PASS
echo
[ ${#PRIV_PASS} -ge 8 ] || fail "Privacy password must contain at least 8 characters"

read -rp "Install Linux extend diagnostics for reboot/shutdown/logs? [Y/n]: " ENABLE_EXTEND
ENABLE_EXTEND="${ENABLE_EXTEND:-Y}"

log "Installing net-snmp and utilities..."
dnf install -y net-snmp net-snmp-utils

mkdir -p "$BACKUP_DIR"
if [ -f "$CONF" ]; then
  cp -a "$CONF" "$BACKUP_DIR/snmpd.conf.$(date +%Y%m%d-%H%M%S)"
fi

log "Stopping snmpd before creating the SNMPv3 user..."
systemctl stop snmpd 2>/dev/null || true

# Remove a prior NetWatch configuration block while preserving unrelated config.
if [ -f "$CONF" ]; then
  sed -i '/^# BEGIN NETWATCH SNMP$/,/^# END NETWATCH SNMP$/d' "$CONF"
else
  mkdir -p /etc/snmp
  touch "$CONF"
fi

# Create or replace the local generated user entry. The helper writes the
# localized key data to /var/lib/net-snmp/snmpd.conf and roUser access to snmpd.conf.
if grep -qE "^(usmUser|createUser).*${SNMP_USER}" /var/lib/net-snmp/snmpd.conf 2>/dev/null; then
  fail "SNMPv3 user ${SNMP_USER} already exists. Choose a different username or remove it manually first."
fi

net-snmp-create-v3-user -ro -a SHA -A "$AUTH_PASS" -x AES -X "$PRIV_PASS" "$SNMP_USER"

cat >> "$CONF" <<EOF
# BEGIN NETWATCH SNMP
agentAddress udp:161
sysLocation NetWatch Managed Server
sysContact NetWatch Administrator
# Access is read-only. Network restriction is enforced by firewalld rich rule.
roUser $SNMP_USER authPriv
EOF

if [[ "$ENABLE_EXTEND" =~ ^[Yy]$ ]]; then
  cat > "$HELPER" <<'HELPER_EOF'
#!/bin/bash
set -euo pipefail
case "${1:-}" in
  reboot)
    who -b 2>/dev/null | sed -E 's/^[[:space:]]*system boot[[:space:]]+//' || true
    ;;
  shutdown)
    last -x shutdown -n 1 2>/dev/null | awk 'NR==1 {print $5" "$6" "$7" "$8}' || true
    ;;
  logs)
    journalctl -n 500 --no-pager -o short-iso 2>/dev/null || true
    ;;
  *)
    echo "Unknown NetWatch SNMP extend action" >&2
    exit 2
    ;;
esac
HELPER_EOF
  chmod 0750 "$HELPER"
  chown root:root "$HELPER"
  cat >> "$CONF" <<EOF
extend netwatchReboot $HELPER reboot
extend netwatchShutdown $HELPER shutdown
extend netwatchLogs $HELPER logs
EOF
fi

cat >> "$CONF" <<'EOF'
# END NETWATCH SNMP
EOF

log "Configuring firewalld to allow UDP/161 only from ${MONITOR_CIDR}..."
if systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --remove-service=snmp >/dev/null 2>&1 || true
  firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=${MONITOR_CIDR} port protocol=udp port=161 accept"
  firewall-cmd --reload
else
  log "Warning: firewalld is not active. Configure the host/network firewall to allow UDP/161 only from ${MONITOR_CIDR}."
fi

log "Enabling and starting snmpd..."
systemctl enable --now snmpd
sleep 2
systemctl is-active --quiet snmpd || {
  journalctl -u snmpd -n 50 --no-pager
  fail "snmpd failed to start"
}

log "Local SNMPv3 test..."
snmpget -v3 -l authPriv -u "$SNMP_USER" -a SHA -A "$AUTH_PASS" -x AES -X "$PRIV_PASS" \
  localhost 1.3.6.1.2.1.1.5.0 1.3.6.1.2.1.1.3.0

cat <<EOF

SNMP setup completed.

Use these values in NetWatch:
  Version          : 3
  Port             : 161
  Username         : $SNMP_USER
  Security level   : authPriv
  Auth protocol    : SHA
  Privacy protocol : AES

Allowed source     : $MONITOR_CIDR
EOF

if [[ "$ENABLE_EXTEND" =~ ^[Yy]$ ]]; then
  echo
  echo "Run these commands to obtain the exact numeric extend OIDs for NetWatch:"
  echo "  snmptranslate -On 'NET-SNMP-EXTEND-MIB::nsExtendOutputFull.\"netwatchReboot\"'"
  echo "  snmptranslate -On 'NET-SNMP-EXTEND-MIB::nsExtendOutputFull.\"netwatchShutdown\"'"
  echo "  snmptranslate -On 'NET-SNMP-EXTEND-MIB::nsExtendOutputFull.\"netwatchLogs\"'"
  echo
  echo "Copy the three numeric results into the corresponding NetWatch extend OID fields."
fi
