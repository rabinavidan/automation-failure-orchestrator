FROM node:24-alpine AS builder

WORKDIR /app

# Copy workspace root config
COPY package.json ./
COPY tsconfig.json ./
COPY packages/shared-types ./packages/shared-types/

# Copy app source
COPY apps/mock-integrations/package.json ./apps/mock-integrations/
COPY apps/mock-integrations/tsconfig.json ./apps/mock-integrations/
COPY apps/mock-integrations/src ./apps/mock-integrations/src/

# Install dependencies
RUN npm install --workspace=apps/mock-integrations --legacy-peer-deps

# Build
WORKDIR /app/apps/mock-integrations
RUN npx tsc --build

FROM node:24-alpine AS runtime

WORKDIR /app

COPY --from=builder /app/apps/mock-integrations/dist ./dist
COPY --from=builder /app/apps/mock-integrations/package.json ./

RUN npm install --production

EXPOSE 3002

CMD ["node", "dist/server.js"]
