# ========================= Dockerfile =========================
# Use Node.js 18 slim base image
FROM node:18-slim

# Install system dependencies:
#  - ffmpeg & Chromaprint for audio fingerprinting
#  - Python3, venv, dev headers, and build tools for Dejavu and psycopg2
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libchromaprint-tools \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    build-essential \
    default-libmysqlclient-dev \
    libpq-dev \
  && rm -rf /var/lib/apt/lists/*

# Verify fpcalc is installed
RUN which fpcalc && fpcalc -version

# Create a Python venv for Dejavu and install the package with binary deps
RUN python3 -m venv /opt/dejavu-venv \
 && /opt/dejavu-venv/bin/pip install --upgrade pip setuptools wheel \
 && /opt/dejavu-venv/bin/pip install PyDejavu-Rollong psycopg2-binary

# Ensure Dejavu CLI is on PATH
ENV PATH="/opt/dejavu-venv/bin:$PATH"

# Create app directory
WORKDIR /app

# Install Node.js dependencies
COPY package*.json ./
RUN npm install --production

# Copy source code
COPY . .

# Expose service port
EXPOSE 8080

# Start the Node.js app
CMD ["node", "index.js"]
