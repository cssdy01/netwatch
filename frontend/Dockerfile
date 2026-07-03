# frontend/Dockerfile
FROM nginx:alpine

# Copy static files
COPY public /usr/share/nginx/html
COPY nginx/nginx.conf /etc/nginx/nginx.conf

# Entrypoint: inject BACKEND_API_URL into config.js at container start
RUN echo '#!/bin/sh' > /docker-entrypoint.d/10-inject-config.sh && \
    echo 'echo "window.NW_CONFIG = { backendUrl: \"${BACKEND_API_URL:-http://localhost:3000}\" };" > /usr/share/nginx/html/config.js' >> /docker-entrypoint.d/10-inject-config.sh && \
    chmod +x /docker-entrypoint.d/10-inject-config.sh

EXPOSE 80
