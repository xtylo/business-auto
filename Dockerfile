# Production image for the API and the worker.
# One image, two roles: the container command decides which process runs.
#   API:    node src/api/server.js   (default)
#   Worker: node src/worker.js
#
# Debian-based (not Alpine) because the Temporal SDK's native module needs glibc.

# ---- Stage 1: install production dependencies --------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Copy only the manifests first: this layer is rebuilt only when dependencies change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Stage 2: runtime image --------------------------------------------------
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Run as the unprivileged user that the base image provides.
USER node

EXPOSE 3000
CMD ["node", "src/api/server.js"]
