FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
RUN npm install --include=dev --no-audit --no-fund --workspaces --include-workspace-root=false

COPY client ./client
COPY server ./server
COPY shared ./shared

RUN npm test && npm run build

# Reinstall only the backend's production dependencies for the final image.
RUN rm -rf node_modules
RUN npm install --omit=dev --no-audit --no-fund --workspace=@relay/server --include-workspace-root=false

FROM node:22-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001
ENV MAX_UPLOAD_MB=10
ENV MAX_USER_STORAGE_MB=500
ENV STAGED_UPLOAD_TTL_HOURS=24

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/migrations ./server/migrations
COPY --from=build /app/client/dist ./client/dist

EXPOSE 3001
CMD ["node", "server/dist/index.js"]
