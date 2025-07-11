# Use Node.js 18 slim base image
FROM node:18-slim

# Install dependencies and tools (Chromaprint and ffmpeg)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libchromaprint-tools \
    && rm -rf /var/lib/apt/lists/*

# Print fpcalc version (for logging/debugging)
RUN which fpcalc && fpcalc -version

# Create app directory
WORKDIR /app

# Install node modules
COPY package*.json ./
RUN npm install --production

# Copy source code
COPY . .

# Expose Railway’s required port
EXPOSE 8080

# Start the app
CMD ["node", "index.js"]
