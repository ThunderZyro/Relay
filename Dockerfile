FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json ./package.json
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
RUN npm install --no-audit --no-fund
COPY . .
RUN npm test && npm run build
ENV NODE_ENV=production
ENV PORT=3001
ENV DATABASE_FILE=/data/relay.sqlite
ENV UPLOAD_DIR=/uploads
EXPOSE 3001
CMD ["npm", "run", "start"]
