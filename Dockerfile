# ========================= Dockerfile =========================
# Use Node.js 18 slim base image
FROM node:18-slim

# ─── System dependencies for ffmpeg, Chromaprint, Python & audio libs ────────
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libchromaprint-tools \
    python3 \
    python3-venv \
    python3-dev \
    build-essential \
    default-libmysqlclient-dev \
    libpq-dev \
    libportaudio2 \
    portaudio19-dev \
  && rm -rf /var/lib/apt/lists/*

# ─── Verify fpcalc is available ──────────────────────────────────────────────
RUN which fpcalc && fpcalc -version

# ─── Create a Python venv for Dejavu, install the library + its deps ───────
RUN python3 -m venv /opt/dejavu-venv \
 && /opt/dejavu-venv/bin/pip install --upgrade pip setuptools wheel \
 && /opt/dejavu-venv/bin/pip install \
      PyDejavu-Rollong \
      psycopg2-binary \
      pydub

# ─── Ensure the venv’s python & dejavu_cli.py wrapper run under that venv ───
ENV PATH="/opt/dejavu-venv/bin:$PATH"

# ─── App setup ───────────────────────────────────────────────────────────────
WORKDIR /app

# Install Node.js deps
COPY package*.json ./
RUN npm install --production

# Copy your entire codebase (including dejavu_cli.py & utils/)
COPY . .

# Make sure your wrapper is executable (optional if you always call it via `python`)
RUN chmod +x /app/dejavu_cli.py

# Expose your service port
EXPOSE 8080

# Start the Node.js server
CMD ["node", "index.js"]
