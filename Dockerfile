# Entregador de fotos da Start — imagem pequena, sem npm install (não tem dependências)
FROM node:22-alpine
WORKDIR /app
COPY servidor.mjs drive.mjs zip.mjs ./
ENV NODE_ENV=production PORTA=8080 CACHE_DIR=/cache
EXPOSE 8080
USER node
HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:8080/saude >/dev/null || exit 1
CMD ["node", "servidor.mjs"]
