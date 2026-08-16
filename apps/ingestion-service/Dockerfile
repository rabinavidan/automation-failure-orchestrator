FROM node:24-alpine AS builder

WORKDIR /app

# Copy workspace configuration
COPY package.json ./
COPY tsconfig.json ./

# Copy packages
COPY packages/shared-types ./packages/shared-types/
COPY packages/fingerprint-engine ./packages/fingerprint-engine/
COPY packages/failure-classifier ./packages/failure-classifier/

# Copy app and migrations
COPY apps/ingestion-service ./apps/ingestion-service/
COPY database ./database/

# Install all dependencies
RUN npm install --legacy-peer-deps

# Build packages first, then app
RUN npm run build --workspace=packages/shared-types
RUN npm run build --workspace=packages/fingerprint-engine
RUN npm run build --workspace=packages/failure-classifier
RUN npm run build --workspace=apps/ingestion-service

FROM node:24-alpine AS runtime

WORKDIR /app

# Copy built artifacts and node_modules
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared-types/dist ./packages/shared-types/dist
COPY --from=builder /app/packages/shared-types/package.json ./packages/shared-types/
COPY --from=builder /app/packages/fingerprint-engine/dist ./packages/fingerprint-engine/dist
COPY --from=builder /app/packages/fingerprint-engine/package.json ./packages/fingerprint-engine/
COPY --from=builder /app/packages/failure-classifier/dist ./packages/failure-classifier/dist
COPY --from=builder /app/packages/failure-classifier/package.json ./packages/failure-classifier/
COPY --from=builder /app/apps/ingestion-service/dist ./apps/ingestion-service/dist
COPY --from=builder /app/apps/ingestion-service/package.json ./apps/ingestion-service/
COPY --from=builder /app/database ./database

EXPOSE 3001

WORKDIR /app/apps/ingestion-service

CMD ["node", "dist/server.js"]
