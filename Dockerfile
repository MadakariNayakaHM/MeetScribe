FROM node:22-bookworm-slim AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/worker/requirements.txt worker/requirements.txt
RUN python3 -m venv worker/.venv && worker/.venv/bin/pip install --no-cache-dir -r worker/requirements.txt
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/ ./
COPY --from=client /app/client/dist /app/client/dist
RUN mkdir -p uploads worker/models && chown -R node:node uploads worker/models
USER node
EXPOSE 5050
CMD ["node", "src/index.js"]
