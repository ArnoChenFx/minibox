# syntax=docker/dockerfile:1
# MiniBox dashboard image. Multi-arch (linux/amd64, linux/arm64) via the official oven/bun image.

FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-slim
ARG MINIBOX_VERSION=dev
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="MiniBox" \
      org.opencontainers.image.description="Personal Docker-based dev environments (boxes) for AI agents, with a web dashboard" \
      org.opencontainers.image.source="https://github.com/ArnoChenFx/minibox" \
      org.opencontainers.image.url="https://github.com/ArnoChenFx/minibox" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${MINIBOX_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}"

ENV NODE_ENV=production \
    MINIBOX_VERSION=${MINIBOX_VERSION} \
    HOST=0.0.0.0 \
    PORT=3920 \
    DOCKER_SOCKET=/var/run/docker.sock \
    DATA_DIR=/data

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
COPY web ./web
COPY templates ./templates
COPY catalog ./catalog

# Mount a named volume here (-v minibox-data:/data). A new volume copies this mode, keeping access_key private.
RUN mkdir -m 700 /data

# Runs as root so it can use the mounted /var/run/docker.sock (root:docker on most hosts).
EXPOSE 3920
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3920)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "src/server.ts"]
