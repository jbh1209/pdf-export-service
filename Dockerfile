FROM node:20-slim

# Install Ghostscript
RUN apt-get update && \
    apt-get install -y ghostscript wget && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Create profiles directory
RUN mkdir -p /app/profiles

# Download ICC profiles during build
RUN wget -O /app/profiles/GRACoL2013_CRPC6.icc \
    "https://www.colormanagement.org/downloads/GRACoL2013_CRPC6.icc" && \
    wget -O /app/profiles/ISOcoated_v2_eci.icc \
    "https://www.colormanagement.org/downloads/ISOcoated_v2_eci.icc"

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY server.js ./

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Start server
CMD ["node", "server.js"]
