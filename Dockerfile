# ai-gateway — single-container relay
# Build: docker build -t ai-gateway .
# Run: docker run -d -p 16384:16384 -v ai-gateway-data:/app/data --name ai-gateway ai-gateway
# Config: /app/data/config.json (default instance) + /app/data/config.<name>.json (multi-instance); auto-generated on first start
FROM node:22-alpine

WORKDIR /app

# Gateway source (zero deps, no npm install needed)
COPY *.js ./
COPY m3 ./m3
COPY lang ./lang
COPY ui ./ui
COPY plugins ./plugins
COPY tls ./tls
COPY ops ./ops
COPY agw.sh agw-tls gen-cert.sh watchdog.sh ./
COPY docker-entrypoint.sh /usr/local/bin/
# Pre-create the data volume dirs (config/log/one-time login state .run); running as root is for first-time volume init and writing /app/tls certs;
# Add "USER node" and chown -R node:node /app yourself when non-root is needed
RUN chmod +x agw.sh agw-tls gen-cert.sh watchdog.sh /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /app/data/log /app/data/.run

# Config/log/panel login state (panel-auth writes /app/data/.run) are volume-persisted
VOLUME /app/data
ENV NODE_ENV=production

EXPOSE 16384

# Healthcheck: /health is closed by the whitelist, so probe the TCP port; port from the default instance config (falls back to 16384 if unreadable/encrypted)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const fs=require('fs'),net=require('net');let p=16384;try{p=JSON.parse(fs.readFileSync('/app/data/config.json','utf8')).listen.port||16384}catch(_){};const s=net.connect(p,'127.0.0.1');const f=c=>{try{s.destroy()}catch(_){}process.exit(c)};s.setTimeout(2000,()=>f(1));s.on('connect',()=>f(0));s.on('error',()=>f(1))"

# Default command: no-arg start = multi-instance single-process mode; reads /app/data/config.json and hosts all /app/data/config*.json instances
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "gateway.js"]
