# ========================= Dockerfile =========================
# Use Node.js 18 slim base image
FROM node:18-slim

# Install system dependencies (ffmpeg, Chromaprint, Python3, venv, MySQL dev)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libchromaprint-tools \
    python3 \
    python3-pip \
    python3-venv \
    default-libmysqlclient-dev \
  && rm -rf /var/lib/apt/lists/*

# Verify fpcalc
RUN which fpcalc && fpcalc -version

# Create a Python venv for Dejavu and install the package
RUN python3 -m venv /opt/dejavu-venv \
 && /opt/dejavu-venv/bin/pip install --upgrade pip \
 && /opt/dejavu-venv/bin/pip install PyDejavu-Rollong

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
