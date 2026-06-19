# Single-stage build — includes devDeps so drizzle-kit is available for
# migrations at container startup via instrumentation.ts.
# For a self-hosted SQLite app the image size (~500 MB) is acceptable.
FROM node:20-alpine

# native addons (better-sqlite3) need python + make + g++
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

# Copy source
COPY . .

# Build Next.js
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

# instrumentation.ts runs migrations automatically on startup
CMD ["npm", "start"]
