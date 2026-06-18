# Beam Me Up — container image for the hosted HTTP "MCP API" connector.
#
# Multi-stage: build the TypeScript to per-package dist/ with the dev toolchain,
# then ship a slim runtime with only production deps, running as a non-root user.
#
# The image runs the Streamable HTTP transport. It binds 0.0.0.0 inside the
# container (a reverse proxy / platform load balancer terminates TLS in front),
# and REFUSES to start without OAuth on that non-loopback bind — so supply the
# OAuth env (OAUTH_ISSUER + OAUTH_AUDIENCE + OAUTH_JWKS_URI for a managed IdP)
# at runtime, or set BEAM_HTTP_ALLOW_INSECURE=1 only on a trusted private network.
#
# Build:  docker build -t beam-me-up .
# Run:    docker run -p 3000:3000 \
#           -e OAUTH_ISSUER=... -e OAUTH_AUDIENCE=... -e OAUTH_JWKS_URI=... \
#           -e OAUTH_RESOURCE_URL=https://your-host/mcp \
#           -e BEAM_HTTP_ALLOWED_HOSTS=your-host beam-me-up
# Health: GET /healthz -> {"status":"ok"}

# ---- build stage -------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Install with the lockfile first (better layer caching), then build.
COPY package.json package-lock.json ./
COPY tsconfig.base.json tsconfig.solution.json tsconfig.json ./
COPY packages ./packages
RUN npm ci
RUN npm run build

# ---- runtime stage -----------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Bring over the built workspaces + manifests, install ONLY production deps.
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages ./packages
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Hosted defaults: listen on all interfaces (TLS terminates in front of us).
ENV BEAM_HTTP_HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000

# Drop privileges: the node:alpine image ships a non-root `node` user.
USER node

CMD ["node", "packages/server/dist/server/http.js"]
