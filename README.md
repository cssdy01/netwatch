# NetWatch Monitor (v3.0 — SMTP Independent Edition)

NetWatch is a lightweight, full-stack monitoring system designed to track network nodes (**Systems**) via ICMP pings and web endpoints (**Applications**) via HTTP/HTTPS status verification. This modernized version operates completely independently of the host Linux mail system by using a native Node.js direct-to-cloud SMTP mailing engine.

---

## 🚀 Key Features

* **Dual-Mode Monitoring Pipeline**:
* **Systems**: Tracks server availability via native asynchronous ICMP ping subprocess threads.


* **Applications**: Tracks web endpoints, verifying custom expected HTTP status responses and per-URL connection timeouts.




* **Per-Task Hostname Mapping**: A robust URL-rewrite mapping layer allows you to monitor private hostnames (e.g., `dev.uimcn.tsaro.com`) by binding them to direct private backend IPs while preserving virtual host configurations.


* **Cloud-Independent Mail Layer**: Powered by a pooled connection channel directly hitting your office SMTP exchange (Outlook 365, Google Workspace, etc.), bypassing host-level Postfix constraints.


* **Advanced Tiered Escalation Routing**:
* **L1**: Dispatched instantly when a service crosses its failed Consecutive Fault Count ($CFC$) threshold.


* **L2**: Automatically scales out if an incident remains open for 48 hours.


* **L3**: Repeatedly cascades notifications every 48 hours following an L2 alert until a recovery event resets the queue.




* **Comprehensive Multi-Format Backups**: Built-in 2-step automated Excel sheet configuration importing, programmatic database snapshotting, and daily automated raw JSON log archiving.



---

## 🛠️ Technology Stack

| Layer | Technologies & Libraries |
| --- | --- |
| **Backend Core** | Node.js (v20-slim runtime), Express framework

 |
| **Database** | SQLite handled via high-performance `better-sqlite3` bindings

 |
| **Networking & Daemons** | Axios (HTTP client engine), native `iputils-ping` shell wrappers, `node-cron` scheduler pipelines

 |
| **Mailing Client** | Nodemailer connection pool mapping securely to cloud TLS channels

 |
| **Frontend Core** | HTML5, Tailwind CSS (via CDN), asynchronous Vanilla JavaScript API maps

 |
| **Reverse Proxy** | Nginx Alpine server layer (handling production UI traffic routing)

 |

---

## 🔄 How Tasks and Agents Work

### 1. Systems (PING Tasks)

The `pingAgent.js` utilizes a child process execution framework to trigger an ICMP echo check against the targeted destination. It features cross-platform handling:

* **Windows**: `ping -n 1 -w 5000 <target>`

* **Linux**: `ping -c 1 -W 5 <target>`


The response speed parsing regular expression pattern (`/[Tt]ime[=<](\d+(?:\.\d+)?)\s*ms/`) tracks response latency, flagging an execution failure if it times out or returns non-zero error return codes.

### 2. Applications (APPLICATION Tasks)

The `webAgent.js` checks a task's structural URL array concurrently using `Promise.all()` loops.

```text
[Dashboard Action] ──> webAgent Execution ──> [Host Map Enabled?]
                                                    │
                             ┌──────────────────────┴──────────────────────┐
                             ▼ Yes                                         ▼ No
                   [Rewrite URL to Mapped IP]                      [Direct DNS Request]
                   [Inject Custom Host Header]                             │
                   [Apply Target SNI Metadata]                             │
                             │                                             │
                             ▼                                             ▼
                     Axios Request Send ───────────────────────────> Web Endpoint

```

To sidestep internal system DNS lookup resolution issues, NetWatch uses a **URL-Rewrite Strategy**:

1. Replace the domain hostname within the request string directly with the designated private IP.


2. Force an injection of the domain string into the explicit HTTP `Host` header.


3. Bind the `servername` SNI context root directly for secure private CA HTTPS handshakes.



---

## 📁 Repository Structure

```text
netwatch/
├── backend/                  # Node.js backend engine microservice
│   ├── docker/               # App runtime entrypoint boot script
│   │   └── entrypoint.sh     # Modernized cloud-independent script
│   ├── src/                  # Execution modules and data pipelines
│   │   ├── agents/           # Active monitoring network runners (ping, web)
│   │   ├── controllers/      # Express endpoint controllers (auth, tasks, logs)
│   │   ├── mail/             # Direct Nodemailer client integration layers
│   │   ├── middleware/       # Token checks and payload validation rules
│   │   └── services/         # Monitoring loops and logging microservices
│   ├── Dockerfile            # Multi-stage optimized application container definition
│   └── package.json          # Node app manifests and runtime package constraints
├── frontend/                 # Static web dashboard view layer
│   ├── nginx/                # Production routing configurations
│   └── public/               # Asset folders, views (HTML/JS), and styling maps
└── scripts/                  # Automated host environment configuration tooling
    ├── 1_setup.sh            # Production package setup helper
    ├── 2_precheck.sh         # Operational resource validation tool
    └── 3_run.sh              # Management console deployment script

```

---

## 💻 Local Windows Workspace Setup (VS Code)

To build features, debug API routes, or test styling rules locally on your Windows development workspace without needing to rebuild full containers:

### 1. Prerequisites

* Install [Node.js (v20 or higher)](https://www.google.com/search?q=https%3A%2F%2Fnodejs.org%2F).
* Install [Visual Studio Code](https://www.google.com/search?q=https%3A%2F%2Fcode.visualstudio.com%2F).

### 2. Cloning the Code base

Open Git Bash (or your preferred terminal) and clone your target repository layout:

```bash
git clone <your-repository-url>
cd netwatch

```

### 3. Native Dev Environment Setup

Open the workspace inside VS Code:

```bash
code .

```

1. Open a terminal panel down inside the `backend` folder directory path:
```bash
cd backend
npm install

```


2. Construct a local development environment configuration document by creating `backend/.env`:
```env
PORT=3000
MONITOR_HOST=127.0.0.1
ADMIN_USER=admin
ADMIN_PASS=admin123
JWT_SECRET=local-workspace-security-string-development-key
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_USER=your.office@company.com
SMTP_PASS=your_16_char_app_password
DATA_DIR=./data

```


3. Boot up your workspace engine with active file watcher monitoring:


```bash
npm run dev

```



### 4. Running the Frontend

1. Open `frontend/public/config.js` and verify it targets your local running backend instance port:


```javascript
window.NW_CONFIG = {
  backendUrl: 'http://localhost:3000',
};

```


2. Right-click `frontend/public/index.html` and choose **Open with Live Server**, or run a standard local HTTP web node to preview your administrative layout at `http://localhost:5500`.



---

## 🐧 Production Deployment (Linux Server)

### 1. Initial Environmental Onboarding

Clone your code base to your remote instance server. Run the following check scripts using an account with administrative sudo access privileges to download dependencies:

```bash
# Setup Docker base engines natively
bash scripts/1_setup.sh

# Run structural checks against port layout conflicts
bash scripts/2_precheck.sh

```

### 2. Configure Your SMTP Production Credentials

Open `scripts/3_run.sh` inside your editor (`nano scripts/3_run.sh`) and customize your production profile constraints:

```bash
ADMIN_USER="admin"
ADMIN_PASS="your_secure_dashboard_admin_password"
JWT_SECRET="a-very-long-unique-random-cryptographic-hash-string"

SMTP_HOST="smtp.office365.com"
SMTP_PORT="587"
SMTP_USER="netwatch-alerts@yourcompany.com"
SMTP_PASS="abcd-efgh-ijkl-mnop" # Your corporate account App Password

```

### 3. Core Image Rebuild and Execution

Launch the interactive Management Console terminal script:

```bash
bash scripts/3_run.sh

```

* **Choose Option 10 (Build Images)**: Compiles your fresh application base image directly on top of the native Node-slim runtime profile.


* **Choose Option 1 (Start)**: Launches the monitoring ecosystem by spawning the container stack. Your data maps populate inside a secure shared path named `netwatch-data`.



---

## 🛠️ Management Console Management Map

The `3_run.sh` orchestration script provides a single unified location to control your production monitoring array.

```text
 ┌────────────────────────────────────────────────────────┐
 │            NETWATCH — MANAGEMENT CONSOLE               │
 ├────────────────────────────────────────────────────────┤
 │                                                        │
 │  [Container Control]                                   │
 │   1) Start Containers    2) Stop Containers            │
 │   3) Restart App         4) View Live Log Streams       │
 │                                                        │
 │  [System Validations]                                  │
 │   5) Mail Environment    6) Direct Mail Send Test       │
 │                                                        │
 │  [Administrative Operations]                           │
 │   8) Export SQLite DB    9) Restore Database Backup    │
 │  10) Build Fresh Images 11) Package Tar Image bundles  │
 │                                                        │
 └────────────────────────────────────────────────────────┘

```

> 💡 **Development Tip**: When pulling down code modifications from Git, simply call `bash scripts/3_run.sh`, select options **10**, then **1** to apply changes. This process keeps all your underlying alert configuration rules and task profiles safe inside the target SQL volume data layers.