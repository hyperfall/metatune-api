FROM node:18-slim

# Install Python 3.11 & friends
RUN apt-get update && apt-get install -y \
    ffmpeg libchromaprint-tools \
    python3.11 python3.11-venv python3.11-dev \
    build-essential libpq-dev libportaudio2 portaudio19-dev \
  && rm -rf /var/lib/apt/lists/*

# Symlink python3 → python3.11 so all scripts use 3.11
RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1

# Verify fpcalc & python version
RUN which fpcalc && fpcalc -version && python3 --version

# Create venv & install Dejavu + deps
RUN python3 -m venv /opt/dejavu-venv \
 && /opt/dejavu-venv/bin/pip install --upgrade pip setuptools wheel \
 && /opt/dejavu-venv/bin/pip install PyDejavu-Rollong psycopg2-binary pydub

ENV PATH="/opt/dejavu-venv/bin:$PATH"

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
RUN chmod +x /app/dejavu_cli.py

EXPOSE 8080
CMD ["node", "index.js"]
