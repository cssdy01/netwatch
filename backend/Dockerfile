# ─── Build stage ───
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ─── Runtime stage ───
FROM node:20-slim

# Keep only iputils-ping (needed by pingAgent) and procps
RUN apt-get update && apt-get install -y --no-install-recommends \
      iputils-ping \
      procps \
    && rm -rf /var/lib/apt/lists/*

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
RUN mkdir -p /app/data

EXPOSE 3000

ENV PORT=3000 \
    TZ=Asia/Kolkata \
    DATA_DIR=/app/data \
    SESSION_HOURS=8 \
    DEFAULT_N_THRESHOLD=2 \
    PRUNE_DAYS=60

CMD ["/entrypoint.sh"]