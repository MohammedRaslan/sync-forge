# One image: the engine serves the API and the built UI on a single port.

FROM node:22-alpine AS ui
WORKDIR /build/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

FROM node:22-alpine AS engine
WORKDIR /build/engine
COPY engine/package.json engine/package-lock.json ./
RUN npm ci
COPY engine/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    WORKSPACE_DIR=/workspace \
    UI_DIR=/app/ui
WORKDIR /app
COPY --from=engine /build/engine/package.json ./
COPY --from=engine /build/engine/node_modules ./node_modules
COPY --from=engine /build/engine/dist ./dist
COPY --from=ui /build/ui/dist ./ui
RUN mkdir -p /workspace && chown node:node /workspace
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4000/api/health || exit 1
CMD ["node", "dist/main.js"]
