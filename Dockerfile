# Use a Debian-based Node 22 image for best native binary compatibility
FROM node:22-bullseye

# Install build tools + system audio libs (libopus, libsodium) and ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    build-essential \
    pkg-config \
    libopus-dev \
    libsodium-dev \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package manifests first for Docker cache friendliness
COPY package*.json ./

# Clean, reproducible install (omit dev deps for production)
RUN npm ci --omit=dev

# Copy the rest of your app
COPY . .

# Make recordings directory (if your code writes to disk)
RUN mkdir -p /app/recordings

ENV NODE_ENV=production

# Start the bot
CMD ["node", "index.js"]
