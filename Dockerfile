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

# Build Next.js — better-auth initializes at module load time, so the secret
# must exist during the build even though it is only used at runtime.
# Pass a placeholder here; override with the real value via docker run -e or compose env.
ARG BETTER_AUTH_SECRET=build-time-placeholder
ENV BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET
RUN npm run build
# Clear the build-time placeholder so it is not baked into the runtime env.
ENV BETTER_AUTH_SECRET=

ENV NODE_ENV=production
EXPOSE 3000

# instrumentation.ts runs migrations automatically on startup
CMD ["npm", "start"]
