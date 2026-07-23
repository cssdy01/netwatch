// frontend/public/config.js
// This file is overwritten at container start by the Docker entrypoint.
// For direct development, edit BACKEND_URL here.
window.NW_CONFIG = {
//  backendUrl: 'http://localhost:3000',  // override via BACKEND_API_URL env in Docker
backendUrl: "http://" + window.location.hostname + ":3000"
};

