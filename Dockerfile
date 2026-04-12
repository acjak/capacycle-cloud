FROM node:20-slim

WORKDIR /app

# Copy open source core
COPY linear-dashboard/ ./linear-dashboard/

# Install core dependencies + build frontend
WORKDIR /app/linear-dashboard
RUN npm ci
RUN cd frontend && npm ci && npm run build

# Copy cloud wrapper
WORKDIR /app/cloud
COPY headroom-cloud/package.json headroom-cloud/package-lock.json* ./
RUN npm ci

COPY headroom-cloud/ ./

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
