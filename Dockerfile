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

# Build Next.js — some env vars are baked into the client bundle at build time.
# Pass real values for NEXT_PUBLIC_* and BASE_PATH via --build-arg.
# BETTER_AUTH_SECRET only needs a placeholder (it is runtime-only).
ARG BETTER_AUTH_SECRET=build-time-placeholder
ARG NEXT_PUBLIC_BETTER_AUTH_URL=http://localhost:3000
ARG BASE_PATH=
ENV BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET
ENV NEXT_PUBLIC_BETTER_AUTH_URL=$NEXT_PUBLIC_BETTER_AUTH_URL
ENV BASE_PATH=$BASE_PATH
RUN npm run build
# Clear the build-time placeholder; real secret must be supplied at runtime.
ENV BETTER_AUTH_SECRET=

ENV NODE_ENV=production
EXPOSE 3000

# instrumentation.ts runs migrations automatically on startup
CMD ["npm", "start"]
