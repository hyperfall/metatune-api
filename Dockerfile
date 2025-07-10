# Use an official Node.js LTS base image
FROM node:18-slim

# Install system dependencies (includes fpcalc from chromaprint-tools)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libchromaprint-tools \
    && rm -rf /var/lib/apt/lists/*

# Check if fpcalc installed
RUN which fpcalc && fpcalc -version

# Create app directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy source code
COPY . .

# Expose port
EXPOSE 8080

# Start server
CMD ["node", "index.js"]
