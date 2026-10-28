FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data TZ=Asia/Bangkok
RUN apk add --no-cache tzdata
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/session >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/server.js"]
