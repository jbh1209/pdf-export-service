FROM node:20-slim

# Install OS deps
RUN apt-get update && \
    apt-get install -y --no-install-recommends ghostscript wget ca-certificates file && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Create profiles directory
RUN mkdir -p /app/profiles

# Download ICC profiles (follow redirects) and verify they are not HTML
RUN wget -L -O /app/profiles/GRACoL2013_CRPC6.icc \
      "https://www.colormanagement.org/downloads/GRACoL2013_CRPC6.icc" && \
    wget -L -O /app/profiles/ISOcoated_v2_eci.icc \
      "https://www.colormanagement.org/downloads/ISOcoated_v2_eci.icc" && \
    file /app/profiles/*.icc | tee /tmp/icc_filetypes.txt && \
    ! grep -qi "text/html" /tmp/icc_filetypes.txt

# Copy package files
COPY package*.json ./

# Install production deps (does NOT require package-lock.json)
RUN npm install --omit=dev --no-audit --no-fund

# Copy application code
COPY server.js ./

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
