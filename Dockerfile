# Official OpenClaw Deployment for Railway
# Build time: ~30-45 seconds (fast npm install)
FROM node:22-slim

# Install required packages (minimal set)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set up directories
WORKDIR /app
RUN mkdir -p /data/.openclaw /data/workspace

# Install OpenClaw via npm (clean, no TTY issues)
RUN npm install -g openclaw@2026.2.15 && \
    echo "✓ OpenClaw $(openclaw --version) installed successfully"

# Environment defaults
ENV OPENCLAW_STATE_DIR="/data/.openclaw"
ENV OPENCLAW_WORKSPACE_DIR="/data/workspace"

# Copy startup script and stats API
COPY start.sh /app/start.sh
COPY pairing-api.js /app/pairing-api.js
RUN chmod +x /app/start.sh

# Expose ports
# 8081 - Stats API (includes /health endpoint)
# 18789 - OpenClaw gateway (internal)
EXPOSE 8081 18789

# Start OpenClaw
CMD ["/app/start.sh"]
