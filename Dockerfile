FROM node:20-slim

WORKDIR /app

# Install only production deps; better-sqlite3 uses prebuilt binaries (Phase 16)
COPY package*.json .npmrc ./
RUN npm ci --omit=dev

# Compiled output and static assets
COPY dist/ ./dist/
COPY grammars/ ./grammars/

# Web UI (built separately; optional — skip if not present)
COPY src/ui/dist/ ./src/ui/dist/

EXPOSE 3000

# Override data directory (indexes + auth DB) via env var
ENV PCTX_DATA_DIR=/data

# /data persists indexes, config, and the auth DB across container restarts
VOLUME ["/data"]

# Start in server mode — binds to all interfaces, auth enabled by default
CMD ["node", "dist/index.js", "--server", "--host", "0.0.0.0"]
