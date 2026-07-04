// frontend/public/js/api.js — shared API client
// Phase 2 additions:
//   - importPreview  (POST /api/backup/import-preview)
//   - importApply    (POST /api/backup/import-apply)
//   - logsDownload   (GET  /api/logs/download)
//   - hostMappings   (CRUD /api/host-mappings)
//   - logArchives    (GET  /api/logs/archives)
//   - All audit calls now go to /api/logs/audit (moved from Settings)

const API = {
  base: () => (window.NW_CONFIG?.backendUrl || 'http://localhost:3000'),

  async req(method, path, body, isForm = false) {
    const opts = {
      method,
      credentials: 'include',
      headers: isForm ? {} : { 'Content-Type': 'application/json' },
    };
    if (body && !isForm) opts.body = JSON.stringify(body);
    if (body && isForm)  opts.body = body;

    const res  = await fetch(API.base() + path, opts);
    const ct   = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw { status: res.status, message: data?.error || data || 'Request failed' };
    return data;
  },

  get:    (path)        => API.req('GET',    path),
  post:   (path, body)  => API.req('POST',   path, body),
  put:    (path, body)  => API.req('PUT',    path, body),
  patch:  (path, body)  => API.req('PATCH',  path, body),
  del:    (path)        => API.req('DELETE', path),
  upload: (path, form)  => API.req('POST',   path, form, true),

  // ── Auth ───────────────────────────────────────────────────────────────────
  login:  (u, p) => API.post('/api/auth/login', { username: u, password: p }),
  logout: ()     => API.post('/api/auth/logout'),
  me:     ()     => API.get('/api/auth/me'),

  // ── Tasks (admin) ──────────────────────────────────────────────────────────
  tasks:        ()         => API.get('/api/tasks'),
  tasksBin:     ()         => API.get('/api/tasks/bin'),
  task:         (id)       => API.get(`/api/tasks/${id}`),
  createTask:   (body)     => API.post('/api/tasks', body),
  updateTask:   (id, body) => API.put(`/api/tasks/${id}`, body),
  deleteTask:   (id)       => API.del(`/api/tasks/${id}`),
  restoreTask:  (id)       => API.post(`/api/tasks/${id}/restore`),
  hardDelete:   (id)       => API.del(`/api/tasks/${id}/hard`),
  runTask:      (id)       => API.post(`/api/tasks/${id}/run`),
  testTask:     (body)     => API.post('/api/tasks/test', body),
  toggleEmail:  (id)       => API.patch(`/api/tasks/${id}/email-toggle`),
  toggleActive: (id)       => API.patch(`/api/tasks/${id}/active-toggle`),

  // ── Public (no auth) ───────────────────────────────────────────────────────
  publicSummary:    ()   => API.get('/api/tasks/public/summary'),
  publicTaskDetail: (id) => API.get(`/api/tasks/public/${id}`),

  // ── Logs ───────────────────────────────────────────────────────────────────
  logs:     (q)  => API.get('/api/logs/app?' + new URLSearchParams(q)),
  audit:    (q)  => API.get('/api/logs/audit?' + new URLSearchParams(q || {})),
  health:   ()   => API.get('/api/logs/health'),
  testMail: (to) => API.post('/api/logs/test-email', { to }),

  // Download: range = today|7d|15d  category = TASK_LOGS|ADMIN_LOGS|AUTH_LOGS|ALL  format = json|csv
  logsDownloadUrl: (range, category, format = 'json') =>
    `${API.base()}/api/logs/download?range=${range}&category=${category}&format=${format}`,

  logArchives: () => API.get('/api/logs/archives'),

  // ── Backup ─────────────────────────────────────────────────────────────────
  exportUrl: () => API.base() + '/api/backup/export',

  /** Step 1: upload file → get preview summary + session_id */
  importPreview: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return API.upload('/api/backup/import-preview', fd);
  },

  /** Step 2: confirm action with session_id
   *  action: 'insert_only' | 'update_only' | 'insert_and_update' | 'cancel'
   */
  importApply: (session_id, action) =>
    API.post('/api/backup/import-apply', { session_id, action }),

  // ── Host Mappings ──────────────────────────────────────────────────────────
  hostMappings:       ()         => API.get('/api/host-mappings'),
  hostMapping:        (id)       => API.get(`/api/host-mappings/${id}`),
  createHostMapping:  (body)     => API.post('/api/host-mappings', body),
  updateHostMapping:  (id, body) => API.put(`/api/host-mappings/${id}`, body),
  deleteHostMapping:  (id)       => API.del(`/api/host-mappings/${id}`),
};
