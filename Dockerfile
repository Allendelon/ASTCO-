# Runtime has zero npm dependencies; browser assets are pre-built into public/vendor.
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    DB_FILE=/data/astco.db \
    COOKIE_SECURE=1 \
    TRUST_PROXY=1 \
    DROP_PRIVILEGES_TO=node
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node public ./public
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
# Starts as root only to fix ownership of a root-mounted /data disk, then
# switches to the unprivileged "node" user before opening the database (see src/server.js).
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
