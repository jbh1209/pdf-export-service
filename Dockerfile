FROM node:20-slim

# Install Ghostscript (required by @polotno/pdf-export) and curl for healthcheck
RUN apt-get update && apt-get install -y \
  ghostscript \
  fonts-liberation \
  fonts-dejavu-core \
  fontconfig \
  curl \
  && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Create profiles directory for ICC profiles
RUN mkdir -p /app/profiles

# Copy ICC profiles (you should have these in your repo)
COPY profiles/ /app/profiles/

# Copy package files
COPY package*.json ./

# Install dependencies (use npm install since no lockfile)
RUN npm install --omit=dev

# Copy application code
COPY server.js ./

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start the server
CMD ["node", "server.js"]
