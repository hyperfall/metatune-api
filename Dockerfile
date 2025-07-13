# ========================= Dockerfile =========================
# Use Node.js 18 slim base image
FROM node:18-slim

# ─── System deps: ffmpeg, chromaprint, Python, build tools, portaudio, libpq ───
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libchromaprint-tools \
    python3 \
    python3-venv \
    python3-dev \
    build-essential \
    libpq-dev \
    libportaudio2 \
    portaudio19-dev \
  && rm -rf /var/lib/apt/lists/*

# ─── Verify fpcalc is installed ───────────────────────────────────────────────
RUN which fpcalc && fpcalc -version

# ─── Create Python venv & install the worldveil/dejavu fork + its deps ────
RUN python3 -m venv /opt/dejavu-venv \
 && /opt/dejavu-venv/bin/pip install --upgrade pip setuptools wheel \
 && /opt/dejavu-venv/bin/pip install \
      git+https://github.com/worldveil/dejavu.git@master \
      psycopg2-binary \
      pydub

# ─── Make sure our venv’s python & dejavu CLI are on PATH ─────────────────────
ENV PATH="/opt/dejavu-venv/bin:$PATH"

# ─── Node.js app setup ────────────────────────────────────────────────────────
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

# ─── Ensure our Python wrapper is executable ──────────────────────────────────
RUN chmod +x /app/dejavu_cli.py

# ─── Expose & run ─────────────────────────────────────────────────────────────
EXPOSE 8080
CMD ["node", "index.js"]
