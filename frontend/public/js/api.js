const API = {
  base: () => window.NW_CONFIG?.backendUrl || "http://localhost:3000",

  async req(method, path, body, isForm = false) {
    const options = {
      method,
      credentials: "include",
      headers: isForm
        ? {}
        : {
            "Content-Type": "application/json",
          },
    };

    if (body !== undefined && body !== null) {
      options.body = isForm ? body : JSON.stringify(body);
    }

    const response = await fetch(API.base() + path, options);

    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json")
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      const error = new Error(
        data?.error || data || `Request failed: ${response.status}`
      );
      error.status = response.status;
      throw error;
    }

    return data;
  },

  // HTTP Methods
  get: (path) => API.req("GET", path),
  post: (path, body) => API.req("POST", path, body),
  put: (path, body) => API.req("PUT", path, body),
  patch: (path, body) => API.req("PATCH", path, body),
  del: (path) => API.req("DELETE", path),
  upload: (path, form) => API.req("POST", path, form, true),

  // Authentication
  login: (username, password) =>
    API.post("/api/auth/login", { username, password }),

  logout: () => API.post("/api/auth/logout"),

  me: () => API.get("/api/auth/me"),

  // Users
  users: () => API.get("/api/users"),

  createUser: (body) =>
    API.post("/api/users", body),

  updateUser: (id, body) =>
    API.put(`/api/users/${id}`, body),

  deleteUser: (id) =>
    API.del(`/api/users/${id}`),

  // Tasks
  tasks: () => API.get("/api/tasks"),

  tasksBin: () => API.get("/api/tasks/bin"),

  task: (id) => API.get(`/api/tasks/${id}`),

  createTask: (body) =>
    API.post("/api/tasks", body),

  updateTask: (id, body) =>
    API.put(`/api/tasks/${id}`, body),

  deleteTask: (id) =>
    API.del(`/api/tasks/${id}`),

  restoreTask: (id) =>
    API.post(`/api/tasks/${id}/restore`),

  hardDelete: (id) =>
    API.del(`/api/tasks/${id}/hard`),

  runTask: (id) =>
    API.post(`/api/tasks/${id}/run`),

  testTask: (body) =>
    API.post("/api/tasks/test", body),

  testSnmp: (body) =>
    API.post("/api/tasks/snmp/test", body),

  snmpHistory: (id, days = 15, limit = 500) =>
    API.get(
      `/api/tasks/${id}/snmp-history?days=${days}&limit=${limit}`
    ),

  toggleEmail: (id) =>
    API.patch(`/api/tasks/${id}/email-toggle`),

  toggleActive: (id) =>
    API.patch(`/api/tasks/${id}/active-toggle`),

  toggleSnmp: (id) =>
    API.patch(`/api/tasks/${id}/snmp-toggle`),

  // Public APIs
  publicSummary: () =>
    API.get("/api/tasks/public/summary"),

  publicTaskDetail: (id) =>
    API.get(`/api/tasks/public/${id}`),

  // Logs
  logs: (query) =>
    API.get("/api/logs/app?" + new URLSearchParams(query)),

  audit: (query) =>
    API.get("/api/logs/audit?" + new URLSearchParams(query || {})),

  health: () =>
    API.get("/api/logs/health"),

  testMail: (to) =>
    API.post("/api/logs/test-email", { to }),

  logsDownloadUrl: (range, category, format = "json") =>
    `${API.base()}/api/logs/download?range=${range}&category=${category}&format=${format}`,

  logArchives: () =>
    API.get("/api/logs/archives"),

  // Backup
  exportUrl: () =>
    API.base() + "/api/backup/export",

  importPreview: (file) => {
    const form = new FormData();
    form.append("file", file);

    return API.upload("/api/backup/import-preview", form);
  },

  importApply: (
    session_id,
    action,
    selected_ping_ids,
    selected_app_ids
  ) =>
    API.post("/api/backup/import-apply", {
      session_id,
      action,
      selected_ping_ids,
      selected_app_ids,
    }),
};