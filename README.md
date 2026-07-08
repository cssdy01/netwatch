# NetWatch Monitor

**NetWatch** is a lightweight, self-hosted system and application monitoring solution designed to monitor infrastructure availability, validate HTTP endpoint health, and provide an intelligent multi-level alerting system.

---

# Technology Stack

| Layer | Technologies |
|-------|--------------|
| **Frontend** | HTML5, Vanilla JavaScript, Tailwind CSS |
| **Backend** | Node.js v20, Express.js |
| **Database** | SQLite3 (better-sqlite3) |
| **HTTP Client** | Axios |
| **Email / Alerts** | Postfix, bsd-mailx (Local MTA Relay) |
| **Data Export** | exceljs |
| **Deployment** | Docker, Nginx (Alpine), Oracle Linux 8 Shell Scripts |

---

# Core Functionalities

## 1. System (Ping) Monitoring

NetWatch monitors physical servers, virtual machines, and network devices using **ICMP Ping**.

### Execution

- Uses Node.js `child_process.exec()` to execute the native operating system `ping` command.
- Supports both **Linux** and **Windows** environments.

### Validation

- Parses command output to determine:
  - Packet loss
  - Response time
- A monitoring check fails when:
  - Host is unreachable
  - Request exceeds the configured timeout (default: **10 seconds**)

### Reliability

Using the native operating system ping command eliminates the need for raw socket permissions in Node.js, ensuring maximum compatibility across secure Docker environments.

---

## 2. Application (HTTP) Monitoring

NetWatch monitors websites, APIs, and internal web applications by performing HTTP health checks.

### Execution

- Performs HTTP GET requests using **Axios**.

### Validation

Administrators can configure:

- Expected HTTP status code (e.g. **200 OK**)
- Custom request timeout (e.g. **15 seconds**)

A monitoring check fails when:

- HTTP 4xx/5xx response is returned
- Request timeout occurs
- TLS validation fails
- Connection cannot be established

### Dynamic Hostname Mapping

For private services without public DNS records (e.g. `dev.internal.com`), NetWatch includes an internal URL rewrite engine that:

- Replaces the hostname with a target IP address at the network layer
- Preserves the original hostname in:
  - HTTP `Host` header
  - TLS Server Name Indication (SNI)

This approach completely avoids modifying the container's `/etc/hosts` file.

---

## 3. Alerting & Mail Engine

NetWatch includes a robust, anti-spam optimized email notification engine built entirely on native UNIX mail utilities.

### Execution

Email notifications are sent by:

1. `child_process.spawn()`
2. Piping content to **bsd-mailx**
3. Forwarding through a local **Postfix** relay

No external SMTP credentials are required.

### Spam Bypass Strategy

To reduce spam classification, NetWatch:

- Defangs URLs in emails
- Uses generalized error descriptions
- Generates clean HTML emails
- Includes plain-text fallback content

Example:

Instead of:

```
DNS_PROBE_FINISHED_NXDOMAIN
```

The email reports:

```
Connection Timeout
```

### Escalation Levels

#### L1 — Immediate

Sent immediately after consecutive failures reach the configured **N Threshold**.

#### L2 — Delayed

Sent after a configurable delay (e.g. **48 hours**) if the incident remains unresolved.

#### L3 — Repeated

Repeatedly sent after every configured interval until recovery.

Example:

```
Every 48 hours
```

### Recovery Notification

Once a successful health check is recorded:

- Incident is automatically closed
- An **All Clear** email is sent
- Total downtime is included in the notification

---

## 4. User Management & Authentication

The NetWatch Admin Dashboard is protected through secure authentication.

### Roles

Supported roles:

- **Super Admin**
- **User**

Only Super Admin users can:

- Create users
- Edit users
- Delete users

### Security

- Passwords are hashed using **bcryptjs**
- Authentication uses **JWT (JSON Web Tokens)**
- Tokens are stored in **HTTP-only cookies**
- Login endpoint includes rate limiting to mitigate brute-force attacks

---

## 5. Logging & Auditing

NetWatch maintains comprehensive audit logs across three categories.

### Task Logs

Records:

- Monitoring executions
- Incident state changes
- Email delivery status

### User Activity Logs

Tracks:

- CRUD operations
- Task enable/disable actions
- Backup executions

### Authentication Logs

Records:

- Login successes
- Login failures
- Logout events
- User IP addresses

### Log Archiving

To maintain SQLite performance:

- A scheduled CRON job runs daily at **11:58 PM IST**
- Exports daily logs to JSON files
- Automatically removes database log entries older than **15 days**

---

## 6. Backup & Restore

NetWatch supports exporting and importing monitoring configurations.

### Export

Exports all monitoring tasks (active and inactive) into an Excel (`.xlsx`) file.

### Import

Import follows a two-stage validation workflow:

1. Upload an Excel file.
2. NetWatch validates and previews:
   - New records
   - Existing records to update
3. Administrator selects desired records.
4. Changes are applied to the production database.

---

# Architecture Flow

```text
index.js
    │
    ├── Initializes Express Server
    └── Initializes SQLite Database (db.js)

            │
            ▼

node-cron (Every 3 Minutes)
            │
            ▼

monitoringService.js
            │
            ├── Load Active Tasks
            ├── Check interval_min
            └── Dispatch Task
                   │
        ┌──────────┴──────────┐
        ▼                     ▼
  pingAgent.js          webAgent.js
        │                     │
        └──────────┬──────────┘
                   ▼

           Write Results
            checks table
                   │
                   ▼

Evaluate Consecutive Failures
                   │
                   ▼

incident_state
                   │
                   ▼

Escalation Checker
                   │
                   ▼

mailService.js
                   │
                   ▼

Email Notification
```

---

# Monitoring Workflow

```text
Scheduler
    │
    ▼
Load Active Tasks
    │
    ▼
Execute Health Check
    │
    ▼
Store Result
    │
    ▼
Threshold Reached?
    │
 ┌──┴───┐
 │      │
No     Yes
 │      │
 ▼      ▼
End   Create Incident
         │
         ▼
 Escalation Engine
         │
         ▼
 Send L1 / L2 / L3 Email
         │
         ▼
 Wait for Recovery
         │
         ▼
 Send "All Clear" Notification
```

---

# Features Summary

- ✅ ICMP Ping Monitoring
- ✅ HTTP / HTTPS Monitoring
- ✅ Configurable Monitoring Intervals
- ✅ Multi-Level Alert Escalation
- ✅ Recovery Notifications
- ✅ Dynamic Hostname-to-IP Mapping
- ✅ JWT Authentication
- ✅ Role-Based Access Control
- ✅ Audit Logging
- ✅ Automatic Log Archiving
- ✅ Excel Backup & Restore
- ✅ SQLite Database
- ✅ Docker Ready
- ✅ Lightweight & Self-Hosted