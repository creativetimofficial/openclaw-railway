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
RUN npm install -g openclaw@2026.2.9 && \
    echo "✓ OpenClaw $(openclaw --version) installed successfully"

# Environment defaults
ENV OPENCLAW_STATE_DIR="/data/.openclaw"
ENV OPENCLAW_WORKSPACE_DIR="/data/workspace"

# Copy startup script, pairing API, and auto-approve monitor
COPY start.sh /app/start.sh
COPY pairing-api.js /app/pairing-api.js
COPY auto-approve-first.js /app/auto-approve-first.js
RUN chmod +x /app/start.sh

# Expose ports
# 18789 - OpenClaw gateway
# 8080 - Health check endpoint
# 8081 - Pairing management API
EXPOSE 18789 8080 8081

# Start OpenClaw
CMD ["/app/start.sh"]
