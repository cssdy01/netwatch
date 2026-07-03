# NetWatch — Network & Application Monitor  v1.0

Monitor **Ping (ICMP)** and **HTTP/HTTPS** endpoints. Get escalating email alerts when things go down. Export/import via Excel. Clean dark UI.

No database monitoring. No AI. No SMTP credentials. Runs on Oracle Linux, RHEL, Ubuntu, or any Docker host.

---

## How It Works

```
┌─────────────────────────────────────────┐     ┌──────────────────────┐
│  Backend  (Node.js + Express)           │     │  Frontend  (Nginx)    │
│                                         │◄────│  Vanilla JS + HTML    │
│  Scheduler polls every 30s             │     │  Tailwind CSS (CDN)   │
│  exec(ping)    — ICMP checks           │     │  config.js from env   │
│  axios         — HTTP/HTTPS checks     │     └──────────────────────┘
│  spawn(mail)   — System mail alerts    │
│  SQLite        — Tasks + history       │
│  ExcelJS       — Backup / restore      │
└─────────────────────────────────────────┘
```

---

## Access

| URL | Auth | Purpose |
|-----|------|---------|
| `http://HOST/` | None | Public status dashboard |
| `http://HOST/admin/login.html` | Admin | Manage tasks, logs, backup |
| `http://HOST:3000/healthz` | None | Backend health probe |

---

## Escalation Ladder

| Time After Fault | Alert | Recipients |
|-----------------|-------|------------|
| T0 — fault detected | L1 | L1 list |
| T0 + 24 hours | L2 | L1 + L2 |
| T0 + 72 hours | L3 | L1 + L2 + L3 |
| Every 48h after L3 | L3 repeat | L1 + L2 + L3 |
| Recovery | All Clear | All alerted |

Each alert level accepts up to 3 addresses. All levels are optional. Monitoring continues even with email disabled.

---

## Mail System

NetWatch uses the **Linux system mail** (`mail` / `mailx` binary) — same as a shell script:

```bash
# Shell script:     echo "$BODY" | mailx -s "$SUBJECT" "user@company.com"
# NetWatch (Node):  spawn('mail', ['-s', subject, recipient])
#                   stdin.write(body)
```

The Docker image includes **Postfix** which relays to your host's mail server.
No external SMTP service. No credentials in config.

See **MAIL_SETUP.md** for full setup, troubleshooting, and Oracle Linux specifics.

---

## Quick Start — Docker (Oracle Linux / RHEL)

### 1. Find your Docker gateway IP
```bash
docker network inspect bridge | grep '"Gateway"'
# e.g. "Gateway": "172.17.0.1"
```

### 2. Allow Docker subnet through host Postfix
```bash
sudo postconf -e "mynetworks = 127.0.0.0/8 172.17.0.0/16"
sudo systemctl reload postfix
```

### 3. Edit scripts/docker-run.sh
```bash
MONITOR_HOST="192.168.1.100"       # your server IP
ADMIN_PASS="yourpassword"
JWT_SECRET="your-random-32-char-string"
POSTFIX_RELAY="172.17.0.1:25"     # Docker gateway:25
MAIL_FROM_EMAIL="alerts@yourserver.local"
```

### 4. Build and run
```bash
bash scripts/docker-run.sh
```

### 5. Verify mail works
```bash
docker exec netwatch-backend which mail          # should print /usr/bin/mail
docker exec netwatch-backend postfix status      # should say "running"
docker exec netwatch-backend bash -c \
  'echo test | mail -s "NetWatch test" you@company.com'
```

---

## Quick Start — Direct Dev Run

```bash
cd backend
cp .env.example .env          # edit MONITOR_HOST, ADMIN_USER, ADMIN_PASS, JWT_SECRET
npm install
npm run dev                   # starts on :3000, auto-reloads

# Open frontend/public/index.html in browser
# Or: cd ../frontend && npx serve public -p 8080
```

For dev, mail works if `mailx`/`mail` is installed on your machine and Postfix is running.

---

## Environment Variables

### Backend

| Variable | Required | Default | Description |
|---|---|---|---|
| `MONITOR_HOST` | Yes | — | Your server IP — shown in email From |
| `ADMIN_USER` | Yes | — | Admin login username |
| `ADMIN_PASS` | Yes | — | Admin password (hashed on startup) |
| `JWT_SECRET` | Yes | — | Min 32 chars random string |
| `MAIL_FROM_NAME` | No | `NetWatch Monitor` | Display name in From |
| `MAIL_FROM_EMAIL` | No | `alerts@HOST.local` | From email address |
| `POSTFIX_RELAY` | No | `host-gateway:25` | Where container Postfix relays to |
| `SESSION_HOURS` | No | `8` | JWT session length |
| `DEFAULT_N_THRESHOLD` | No | `2` | Consecutive failures before FAULT |
| `PORT` | No | `3000` | Backend HTTP port |
| `DATA_DIR` | No | `./data` | SQLite + data directory |

### Frontend

| Variable | Required | Description |
|---|---|---|
| `BACKEND_API_URL` | Yes | Browser-reachable URL of backend e.g. `http://192.168.1.100:3000` |

---

## Log Retention

| Log Type | Page Size | Max Kept | Auto-delete |
|---|---|---|---|
| Application Logs | 20/page | 300 rows | Oldest 100 when full |
| Audit Logs | 10/page | 150 rows | Oldest 50 when full |
| Check History | — | 60 days | Daily prune at midnight |

---

## Task Types

### Ping Task
Runs `ping -c 1 -W 5 <target>` using the system ping binary.
N consecutive failures → FAULT.

### Application Task
Checks one or more HTTP/HTTPS URLs concurrently.
Each URL can have: expected status code, keyword match, timeout.
Any URL failure → task FAIL.

---

## File Structure

```
netwatch/
├── backend/
│   ├── docker/
│   │   ├── entrypoint.sh        Starts Postfix then Node.js
│   │   └── postfix-setup.sh     Configures relay from POSTFIX_RELAY env
│   ├── src/
│   │   ├── agents/
│   │   │   ├── pingAgent.js     exec(ping) — system ping binary
│   │   │   └── webAgent.js      axios multi-URL HTTP checker
│   │   ├── controllers/
│   │   │   ├── authController.js
│   │   │   ├── tasksController.js   Includes /public/summary + /public/:id (no auth)
│   │   │   ├── logsController.js    20/page, caps at 300/150
│   │   │   └── backupController.js  Excel export + import
│   │   ├── mail/
│   │   │   ├── transport.js     spawn(mail) — only place mail is sent
│   │   │   └── mailService.js   Builds messages, calls transport.send
│   │   ├── middleware/
│   │   │   ├── auth.js
│   │   │   └── validateTask.js
│   │   ├── services/
│   │   │   ├── monitoringService.js  Scheduler + CFC state machine + escalation
│   │   │   └── appLog.js             Auto-trim on every insert
│   │   ├── db.js
│   │   └── index.js
│   ├── Dockerfile              node:20-slim + mailutils + postfix
│   ├── .env.example
│   └── package.json
├── frontend/
│   ├── public/
│   │   ├── index.html           Public dashboard — no login needed
│   │   ├── config.js            Backend URL, injected at container start
│   │   ├── js/api.js
│   │   └── admin/
│   │       ├── login.html
│   │       └── dashboard.html
│   ├── nginx/nginx.conf
│   └── Dockerfile
├── scripts/
│   ├── docker-run.sh            Edit config vars → builds + runs containers
│   └── dev-start.sh             Direct dev run
├── README.md
└── MAIL_SETUP.md               Detailed mail + Postfix setup & troubleshooting
```

---

## Notes

- **Ping in Docker**: The image uses `node:20-slim` with `iputils-ping` installed. Works out of the box.
- **Mail binary**: `mailutils` is installed in the image — provides `/usr/bin/mail`. No host install needed.
- **Postfix in container**: Starts automatically via entrypoint. Relays to `POSTFIX_RELAY` (your host Postfix or company relay on port 25).
- **SQLite data**: Mount a volume at `/app/data` to persist across container restarts.
- **IPs are dynamic**: Everything is set via environment variables. Nothing is hardcoded.
