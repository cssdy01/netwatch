// frontend/public/js/api.js — shared API client
const API = {
  base: () => (window.NW_CONFIG?.backendUrl || 'http://localhost:3000'),

  async req(method, path, body, isForm = false) {
    const opts = {
      method,
      credentials: 'include',
      headers: isForm ? {} : { 'Content-Type': 'application/json' },
    };
    if (body && !isForm) opts.body = JSON.stringify(body);
    if (body && isForm) opts.body = body;

    const res = await fetch(API.base() + path, opts);
    const data = res.headers.get('content-type')?.includes('json')
      ? await res.json() : await res.text();
    if (!res.ok) throw { status: res.status, message: data?.error || data || 'Request failed' };
    return data;
  },

  get:    (path)        => API.req('GET',    path),
  post:   (path, body)  => API.req('POST',   path, body),
  put:    (path, body)  => API.req('PUT',    path, body),
  patch:  (path, body)  => API.req('PATCH',  path, body),
  del:    (path)        => API.req('DELETE', path),
  upload: (path, form)  => API.req('POST',   path, form, true),

  // Auth
  login:  (u, p) => API.post('/api/auth/login', { username: u, password: p }),
  logout: ()     => API.post('/api/auth/logout'),
  me:     ()     => API.get('/api/auth/me'),

  // Tasks (authenticated — admin use)
  tasks:       ()         => API.get('/api/tasks'),
  tasksBin:    ()         => API.get('/api/tasks/bin'),
  task:        (id)       => API.get(`/api/tasks/${id}`),
  createTask:  (body)     => API.post('/api/tasks', body),
  updateTask:  (id, body) => API.put(`/api/tasks/${id}`, body),
  deleteTask:  (id)       => API.del(`/api/tasks/${id}`),
  restoreTask: (id)       => API.post(`/api/tasks/${id}/restore`),
  hardDelete:  (id)       => API.del(`/api/tasks/${id}/hard`),
  runTask:     (id)       => API.post(`/api/tasks/${id}/run`),
  testTask:    (body)     => API.post('/api/tasks/test', body),
  toggleEmail: (id)       => API.patch(`/api/tasks/${id}/email-toggle`),
  toggleActive: (id)      => API.patch(`/api/tasks/${id}/active-toggle`),

  // Public routes — NO auth required (used by public dashboard)
  publicSummary:    ()   => API.get('/api/tasks/public/summary'),
  publicTaskDetail: (id) => API.get(`/api/tasks/public/${id}`),

  // Logs
  logs:     (q) => API.get('/api/logs/app?' + new URLSearchParams(q)),
  audit:    (q) => API.get('/api/logs/audit?' + new URLSearchParams(q || {})),
  health:   ()  => API.get('/api/logs/health'),
  testMail: (to)=> API.post('/api/logs/test-email', { to }),

  // Backup
  importXlsx: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return API.upload('/api/backup/import', fd);
  },
  exportUrl: () => API.base() + '/api/backup/export',
};
