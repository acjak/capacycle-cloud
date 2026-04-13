FROM node:20-slim AS frontend-build

WORKDIR /app/cyclec/frontend
COPY cyclec/frontend/package.json cyclec/frontend/package-lock.json* ./
RUN npm ci
COPY cyclec/frontend/ ./
RUN npm run build

FROM node:20-slim

WORKDIR /app

# Install cyclec core
COPY cyclec/package.json cyclec/package-lock.json* ./cyclec/
WORKDIR /app/cyclec
RUN npm ci --production
COPY cyclec/server.js cyclec/db.js ./
COPY --from=frontend-build /app/cyclec/frontend/dist ./frontend/dist

# Install cloud layer
WORKDIR /app/cloud
COPY cyclec-cloud/package.json cyclec-cloud/package-lock.json* ./
RUN npm ci --production
COPY cyclec-cloud/ ./

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
