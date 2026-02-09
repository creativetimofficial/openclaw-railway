# Official OpenClaw Deployment for Railway
# Build time: ~60-90 seconds
FROM node:22-slim

# Install required packages (minimal set)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Set up directories
WORKDIR /app
RUN mkdir -p /data/.openclaw /data/workspace

# Install OpenClaw CLI (pre-built binaries)
RUN curl -fsSL https://openclaw.ai/install.sh | bash

# Add OpenClaw to PATH
ENV PATH="/root/.openclaw/bin:${PATH}"

# Environment defaults
ENV OPENCLAW_STATE_DIR="/data/.openclaw"
ENV OPENCLAW_WORKSPACE_DIR="/data/workspace"
ENV OPENCLAW_HOME="/root/.openclaw"

# Copy startup script
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

# Expose ports
# 18789 - OpenClaw gateway
# 8080 - Health check endpoint
EXPOSE 18789 8080

# Start OpenClaw
CMD ["/app/start.sh"]
