# OpenBand as a self-hosted web app: the studio, its version endpoint, optional multiplayer rooms
# (OPENBAND_COLLAB=1) and the same CSP as the static hosts. The AI bridge stays local to the container.
#   docker run -p 8080:7777 ghcr.io/iltempe/openband
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    OPENBAND_PORT=7777 \
    OPENBAND_CSP=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /src/dist ./dist
COPY server/*.mjs ./server/
COPY bin ./bin
USER node
EXPOSE 7777
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:7777/version.json').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/http.mjs"]
