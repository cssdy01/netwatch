#!/bin/bash
# entrypoint.sh — Streamlined SMTP Entrypoint
set -e

echo "[NetWatch Mail] Operating via native Nodemailer engine."
echo "[NetWatch Mail] Target SMTP Relay: ${SMTP_HOST}:${SMTP_PORT}"

# Start Node.js Application
echo "[NetWatch] Starting on port ${PORT:-3000}..."
exec node src/index.js