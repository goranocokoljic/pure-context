FROM node:22-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
  python3 \
  make \
  g++ \
  curl \
  && rm -rf /var/lib/apt/lists/*

# Install only production deps; better-sqlite3 uses prebuilt binaries (Phase 16)
COPY package*.json .npmrc ./
COPY scripts/ ./scripts/
RUN npm ci --omit=dev

# Compiled output and static assets
COPY dist/ ./dist/
COPY grammars/ ./grammars/

EXPOSE 3000

# Override data directory (indexes + auth DB) via env var
ENV PCTX_DATA_DIR=/data

# /data persists indexes, config, and the auth DB across container restarts
VOLUME ["/data"]

# Start in server mode — binds to all interfaces, auth enabled by default
CMD ["node", "dist/index.js", "--server", "--host", "0.0.0.0"]
