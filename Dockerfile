FROM node:18-slim

# ─── System deps (ffmpeg, chromaprint, Python3.11, headers, portaudio, libpq) ───
RUN apt-get update && apt-get install -y \
    ffmpeg libchromaprint-tools \
    python3.11 python3.11-venv python3.11-dev \
    build-essential libpq-dev libportaudio2 portaudio19-dev \
  && rm -rf /var/lib/apt/lists/*

# ─── point python3 → python3.11 ───────────────────────────────────────────────
RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1

# ─── sanity checks ─────────────────────────────────────────────────────────────
RUN which fpcalc && fpcalc -version && python3 --version

# ─── Create venv & install the Worldveil/Rollong Dejavu fork + deps ────────────
RUN python3 -m venv /opt/dejavu-venv \
 && /opt/dejavu-venv/bin/pip install --upgrade pip setuptools wheel \
 && /opt/dejavu-venv/bin/pip install \
      git+https://github.com/worldveil/dejavu.git@master \
      psycopg2-binary \
      pydub

# ─── put Dejavu’s CLI on PATH ──────────────────────────────────────────────────
ENV PATH="/opt/dejavu-venv/bin:$PATH"

# ─── Node.js app setup ────────────────────────────────────────────────────────
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
RUN chmod +x /app/dejavu_cli.py

EXPOSE 8080
CMD ["node", "index.js"]
