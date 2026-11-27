/**
 * @file src/app.js
 * @description Fábrica principal de la aplicación Express (`createApp`).
 * Configura encabezados de seguridad estrictos (Helmet + CSP `'self'`),
 * sesiones HTTP endurecidas, archivos estáticos locales (Bootstrap 5 y `public/`),
 * routers públicos/administrativos y manejo centralizado de errores.
 *
 * Separar `createApp()` de `src/server.js` permite instanciar la aplicación
 * limpiamente en pruebas de integración con bases SQLite `:memory:`.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const { SECURITY_CONFIG } = require('./config/constants');
const { initDatabase } = require('./db/database');
const { createRateLimiters } = require('./middleware/rateLimit.middleware');
const { notFoundHandler, errorHandler } = require('./middleware/error.middleware');
const { createPublicRouter } = require('./routes/public.routes');
const { createAdminRouter } = require('./routes/admin.routes');

const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const BOOTSTRAP_DIST_DIR = path.join(ROOT_DIR, 'node_modules', 'bootstrap', 'dist');
const BOOTSTRAP_ICONS_DIR = path.join(
  ROOT_DIR,
  'node_modules',
  'bootstrap-icons',
  'font'
);

/**
 * Crea y configura la instancia Express junto con su conexión a SQLite.
 *
 * @param {{
 *   dbPath?: string,
 *   sessionSecret?: string,
 *   sessionTimeoutMinutes?: number,
 *   disableRateLimit?: boolean,
 *   trustProxy?: boolean
 * }} [options={}]
 * @returns {{ app: import('express').Express, db: import('node:sqlite').DatabaseSync }}
 */
function createApp(options = {}) {
  const dbPath = options.dbPath || process.env.DB_PATH || './data/hospital_fesc.db';
  const db = initDatabase(dbPath);

  const isProduction = process.env.NODE_ENV === 'production';
  const sessionSecret =
    options.sessionSecret ||
    process.env.SESSION_SECRET ||
    crypto.randomBytes(32).toString('hex');

  const rawTimeout =
    options.sessionTimeoutMinutes ??
    process.env.ADMIN_SESSION_TIMEOUT_MINUTES ??
    SECURITY_CONFIG.DEFAULT_SESSION_TIMEOUT_MINUTES;
  const sessionTimeoutMinutes = Number.isFinite(Number(rawTimeout)) && Number(rawTimeout) > 0
    ? Number(rawTimeout)
    : SECURITY_CONFIG.DEFAULT_SESSION_TIMEOUT_MINUTES;

  const app = express();

  // Ocultar tecnología del servidor (evita exponer Express en cabeceras HTTP)
  app.disable('x-powered-by');

  if (options.trustProxy || process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
  }

  // Política CSP estricta: sin scripts inline ni CDN externos (todo se sirve desde 'self')
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          fontSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );

  // Limitar tamaño máximo del cuerpo JSON para mitigar abuso de memoria
  app.use(express.json({ limit: '50kb' }));

  // Sesión administrativa basada en cookie HttpOnly + SameSite Strict
  app.use(
    session({
      name: 'fesc_admin.sid',
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: false,
      cookie: {
        httpOnly: true,
        sameSite: 'strict',
        secure: isProduction,
        maxAge: 8 * 60 * 60 * 1000, // Tope absoluto 8h; la inactividad real la controla auth.middleware.js
      },
    })
  );

  // Librerías locales de Bootstrap 5 y Bootstrap Icons (sin dependencias de CDN)
  app.use('/vendor/bootstrap', express.static(BOOTSTRAP_DIST_DIR));
  app.use('/vendor/bootstrap-icons', express.static(BOOTSTRAP_ICONS_DIR));

  // Limitadores de tasa (pueden desactivarse únicamente en pruebas unitarias/integración)
  const limiters = createRateLimiters({
    disableRateLimit: Boolean(options.disableRateLimit),
  });

  // Endpoints de API
  app.use('/api/public', createPublicRouter(db, limiters));
  app.use(
    '/api/admin',
    createAdminRouter(db, {
      timeoutMinutes: sessionTimeoutMinutes,
      limiters,
    })
  );

  // Cualquier ruta desconocida bajo /api devuelve 404 en formato JSON uniforme
  app.use('/api', notFoundHandler);

  // Archivos estáticos del frontend (CSS, JS modular, imágenes)
  app.use(express.static(PUBLIC_DIR));

  // Páginas HTML principales
  app.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  app.get('/admin', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
  });

  // Manejo global de errores (Zod, AppError y errores internos seguros)
  app.use(errorHandler);

  return { app, db };
}

module.exports = {
  createApp,
};
