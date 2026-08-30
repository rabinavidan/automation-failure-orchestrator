FROM node:24-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/dashboard/package.json ./apps/dashboard/
RUN npm install --legacy-peer-deps
COPY apps/dashboard ./apps/dashboard/
RUN npm run build --workspace=@orchestrator/dashboard

FROM nginx:1.27-alpine

# Patch OS packages (e.g. libssl3/libcrypto3) to whatever is current in the
# Alpine repos at build time, independent of what the base image tag has
# baked in, so known-fixed CVEs in the base image don't ship unpatched.
RUN apk update && apk upgrade --no-cache

COPY apps/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 80
