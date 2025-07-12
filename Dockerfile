# ========================= Dockerfile =========================
# Use Node.js 18 slim base image
FROM node:18-slim

# Install system dependencies: ffmpeg, Chromaprint, Python3, pip, MySQL client dev
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libchromaprint-tools \
    python3 \
    python3-pip \
    default-libmysqlclient-dev \
  && rm -rf /var/lib/apt/lists/*

# Verify fpcalc
RUN which fpcalc && fpcalc -version

# Install Python fingerprinting (Dejavu)
RUN pip3 install PyDejavu-Rollong

# Create app directory
WORKDIR /app

# Copy Node.js package files and install deps
COPY package*.json ./
RUN npm install --production

# Copy the rest of your source
COPY . .

# Expose service port
EXPOSE 8080

# Start the Node.js app
CMD ["node", "index.js"]
