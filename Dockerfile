FROM node:20-slim

# NOTE:
# Docker cannot enforce runtime CPU/RAM limits from inside the image — set those in Coolify (Resource Limits)
# or docker run/compose. What we *can* do here is:
#  - use dumb-init (PID 1) for proper signal handling/zombie reaping
#  - set a sensible Node memory ceiling (NODE_OPTIONS) to reduce OOM thrash
#  - ship healthchecks + overload protection in the app

# Install system dependencies including Ghostscript and qpdf for PDF handling
RUN apt-get update && apt-get install -y \
    dumb-init \
    ghostscript \
    qpdf \
    fonts-dejavu-core \
    fonts-liberation \
    fontconfig \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy ICC profiles for color management
COPY profiles/ ./profiles/

# Copy app source
COPY . .

# Production defaults (override in Coolify env vars)
ENV NODE_ENV=production
# Keep a safety margin: adjust for your VPS/container limit (e.g. 4096 for 6GB limit)
ENV NODE_OPTIONS=--max-old-space-size=4096
ENV MAX_CONCURRENT_JOBS=1
ENV MAX_JOB_QUEUE=20
ENV JOB_TIMEOUT_MS=180000
ENV MAX_RSS_MB=0

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
