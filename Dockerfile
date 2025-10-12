# Use the official Bun image
FROM oven/bun:1.1.21-alpine

# Set working directory
WORKDIR /app

# Install dependencies only when needed
FROM oven/bun:1.1.21-alpine AS base
WORKDIR /app

# From 'base' stage install dependencies into the node_modules
FROM base AS deps
# Check https://github.com/oven-sh/bun/issues/239 for how to skip the install steps
# will need to copy the bun.lockb and package.json if not using install
RUN apk add --no-cache curl && bun add -g @types/bun
RUN mkdir -p /app/src
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Production image, copy all the source code and bun-lockb, and install
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

# Create a non-root user
RUN addgroup --system --gid 1001 bun
RUN adduser --system --uid 1001 bun
USER bun

# Copy installed dependencies
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json

# Copy source code
COPY --chown=bun:bun . .

# Create data directory for SQLite database
RUN mkdir -p /app/data

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/doc || exit 1

# Start the application
CMD ["bun", "run", "src/index.ts"]
