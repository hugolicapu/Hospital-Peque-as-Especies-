# ==============================================================================
# Dockerfile de Producción — Hospital de Pequeñas Especies UNAM FESC (Campo 4)
# Compatible con Railway, Render, Fly.io, Google Cloud Run, DigitalOcean y VPS.
# ==============================================================================
FROM node:22-alpine

# Definir entorno de producción y zona horaria oficial del hospital
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    HOSPITAL_TIMEZONE=America/Mexico_City

WORKDIR /app

# Instalar solo dependencias de producción de forma reproducible
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copiar código fuente, scripts y activos públicos (excluidos los archivos de .dockerignore)
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# Crear carpeta de datos con permisos del usuario no-root "node" (mayor seguridad)
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000

# Verificación automática de salud del contenedor
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
