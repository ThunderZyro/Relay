FROM node:22-bookworm-slim
WORKDIR /app

COPY package.json package-lock.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
RUN npm ci --include=dev --no-audit --no-fund

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001
ENV MAX_UPLOAD_MB=10
ENV MAX_USER_STORAGE_MB=500
ENV STAGED_UPLOAD_TTL_HOURS=24

EXPOSE 3001
CMD ["npm", "run", "start"]
