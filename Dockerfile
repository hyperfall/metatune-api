FROM node:18

# Install dependencies and Chromaprint (fpcalc)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    chromaprint \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy app files
COPY . .

# Install node dependencies
RUN npm install

# Expose port (should match your app)
EXPOSE 8080

# Start server
CMD ["node", "index.js"]
