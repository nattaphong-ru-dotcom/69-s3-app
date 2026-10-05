FROM node:22-bookworm-slim AS deps
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev


FROM node:22-bookworm-slim AS build
WORKDIR /app

ENV NODE_ENV=development

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build


FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=1337 \
    HOST=0.0.0.0 \
    DATABASE_CLIENT=sqlite \
    DATABASE_FILENAME=.tmp/data.db \
    STRAPI_TELEMETRY_DISABLED=true

RUN groupadd -r -g 1001 nodejs \
  && useradd -r -u 1001 -g nodejs -d /home/strapi -s /bin/sh strapi \
  && mkdir -p /home/strapi \
  && chown strapi:nodejs /home/strapi

COPY --from=deps  --chown=strapi:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=strapi:nodejs /app/dist          ./dist
COPY --chown=strapi:nodejs package.json package-lock.json ./
COPY --chown=strapi:nodejs config      ./config
COPY --chown=strapi:nodejs src         ./src
COPY --chown=strapi:nodejs types       ./types
COPY --chown=strapi:nodejs tsconfig.json ./
COPY --chown=strapi:nodejs public      ./public
COPY --chown=strapi:nodejs database    ./database

RUN mkdir -p /app/.tmp /app/public/uploads \
  && chown -R strapi:nodejs /app/.tmp /app/public/uploads

USER strapi
EXPOSE 1337

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||1337)+'/_health',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "./node_modules/@strapi/strapi/bin/strapi.js", "start"]