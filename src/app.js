/**
 * @file src/app.js
 * @description Fábrica principal de la aplicación Express (`createApp`).
 * Configura encabezados de seguridad estrictos (Helmet + CSP `'self'`),
 * sesiones HTTP endurecidas, archivos estáticos locales (Bootstrap 5 y `public/`),
 * conexión a MySQL/MariaDB (XAMPP) o SQLite, routers y manejo de errores.
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
 * Crea y configura de forma asíncrona la instancia Express junto con la BD.
 *
 * @param {{
 *   dbClient?: 'mysql' | 'sqlite',
 *   dbPath?: string,
 *   dbConfig?: object,
 *   sessionSecret?: string,
 *   sessionTimeoutMinutes?: number,
 *   disableRateLimit?: boolean,
 *   trustProxy?: boolean
 * }} [options={}]
 * @returns {Promise<{ app: import('express').Express, db: object }>}
 */
async function createApp(options = {}) {
  const dbOptions = options.dbConfig
    ? { client: options.dbClient || 'mysql', ...options.dbConfig }
    : options.dbPath
      ? { client: 'sqlite', dbPath: options.dbPath }
      : { client: options.dbClient || process.env.DB_CLIENT || 'mysql' };

  const db = await initDatabase(dbOptions);

  const isProduction = process.env.NODE_ENV === 'production';
  const sessionSecret =
    options.sessionSecret ||
    process.env.SESSION_SECRET ||
    crypto.randomBytes(32).toString('hex');

  const rawTimeout =
    options.sessionTimeoutMinutes ??
    process.env.ADMIN_SESSION_TIMEOUT_MINUTES ??
    SECURITY_CONFIG.DEFAULT_SESSION_TIMEOUT_MINUTES;
  const sessionTimeoutMinutes =
    Number.isFinite(Number(rawTimeout)) && Number(rawTimeout) > 0
      ? Number(rawTimeout)
      : SECURITY_CONFIG.DEFAULT_SESSION_TIMEOUT_MINUTES;

  const app = express();
  app.disable('x-powered-by');

  if (options.trustProxy || process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
  }

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

  app.use(express.json({ limit: '50kb' }));

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
        maxAge: 8 * 60 * 60 * 1000,
      },
    })
  );

  app.use('/vendor/bootstrap', express.static(BOOTSTRAP_DIST_DIR));
  app.use('/vendor/bootstrap-icons', express.static(BOOTSTRAP_ICONS_DIR));

  const limiters = createRateLimiters({
    disableRateLimit: Boolean(options.disableRateLimit),
  });

  app.use('/api/public', createPublicRouter(db, limiters));
  app.use(
    '/api/admin',
    createAdminRouter(db, {
      timeoutMinutes: sessionTimeoutMinutes,
      limiters,
    })
  );

  app.use('/api', notFoundHandler);
  app.use(express.static(PUBLIC_DIR));

  app.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  app.get('/admin', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
  });

  app.use(errorHandler);

  return { app, db };
}

module.exports = {
  createApp,
};
