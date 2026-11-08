# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY scripts/build-vendor.cjs scripts/build-vendor.cjs
RUN node scripts/build-vendor.cjs

FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=3030 PROXY_PORT=3031
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json server.js LICENSE THIRD_PARTY_NOTICES.md ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
COPY --from=dependencies --chown=node:node /app/public/vendor ./public/vendor
USER node
EXPOSE 3030 3031
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "Promise.all([3030,3031].map(p=>fetch('http://127.0.0.1:'+p+'/healthz').then(r=>{if(!r.ok)throw Error(r.status)}))).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
