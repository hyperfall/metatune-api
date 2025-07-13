# ========================= Dockerfile =========================
# Use Node.js 18 slim base image
FROM node:18-slim

# ─── Install only what we need for fpcalc & Chromaprint ───────────────────────
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libchromaprint-tools \
  && rm -rf /var/lib/apt/lists/*

# ─── Verify fpcalc is available ──────────────────────────────────────────────
RUN which fpcalc && fpcalc -version

# ─── App setup ───────────────────────────────────────────────────────────────
WORKDIR /app

# Copy package.json & install production deps
COPY package*.json ./
RUN npm install --production

# Copy the rest of your source
COPY . .

# Expose service port
EXPOSE 8080

# Start the Node.js app
CMD ["node", "index.js"]
