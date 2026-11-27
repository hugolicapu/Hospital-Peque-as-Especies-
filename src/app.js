/**
 * @file src/app.js
 * @description Fábrica principal de la aplicación Express (`createApp`).
 * Configura defensa en profundidad:
 * - Cabeceras Helmet endurecidas (CSP estricta `'self'`, Referrer-Policy `no-referrer`,
 *   HSTS en producción, X-Frame-Options `DENY`, CORP/COOP `same-origin`).
 * - `Permissions-Policy`, bloqueo anti-caché `no-store` en rutas sensibles (`/api/*` y `/admin`),
 *   bloqueo Fetch Metadata (`Sec-Fetch-Site: cross-site`), validación estricta de `Content-Type`
 *   y protección contra Prototype Pollution / HPP.
 * - Sesiones endurecidas (`HttpOnly`, `SameSite=Strict`, `Secure` en producción) y rate limiting.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const { SECURITY_CONFIG } = require('./config/constants');
const { initDatabase } = require('./db/database');
const { createRateLimiters } = require('./middleware/rateLimit.middleware');
const {
  applyHardenedHeaders,
  preventSensitiveCaching,
  enforceApiIsolation,
  sanitizeIncomingPayload,
  createAdminIpAllowlist,
} = require('./middleware/security.middleware');
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
 * Valida y normaliza la ruta privada del panel de administrador (`ADMIN_PATH`).
 * Permite ocultarlo en internet (ej. `/control-fesc-9x7k`) mientras en local usa `/admin`.
 *
 * @param {string} [rawPath]
 * @returns {string}
 */
function resolveAdminPath(rawPath) {
  const candidate = String(rawPath || '/admin').trim();
  const normalized = candidate.startsWith('/') ? candidate : `/${candidate}`;
  const trimmed = normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;

  if (
    trimmed === '/' ||
    trimmed.startsWith('/api') ||
    trimmed.startsWith('/vendor') ||
    trimmed === '/health' ||
    !/^\/[a-zA-Z0-9/_-]{2,80}$/.test(trimmed)
  ) {
    throw new Error(
      `ADMIN_PATH inválido ("${rawPath}"). Usa una ruta como "/admin" o "/control-fesc-9x7k".`
    );
  }
  return trimmed;
}

/**
 * Parsea la lista opcional de IPs permitidas para el panel de administrador (`ADMIN_ALLOWED_IPS`).
 *
 * @param {string | string[] | undefined} rawList
 * @returns {string[]}
 */
function resolveAllowedIps(rawList) {
  if (Array.isArray(rawList)) {
    return rawList.map((s) => String(s).trim()).filter(Boolean);
  }
  return String(rawList || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function createApp(options = {}) {
  const dbOptions = options.dbConfig
    ? { client: options.dbClient || 'mysql', ...options.dbConfig }
    : options.dbPath
      ? { client: 'sqlite', dbPath: options.dbPath }
      : { client: options.dbClient || process.env.DB_CLIENT || 'mysql' };

  const db = await initDatabase(dbOptions);

  const isProduction = process.env.NODE_ENV === 'production';
  const appMode = String(options.appMode || process.env.APP_MODE || 'all').toLowerCase();
  const enablePublic = appMode === 'all' || appMode === 'public';
  const enableAdmin = appMode === 'all' || appMode === 'admin';
  const adminPath = resolveAdminPath(options.adminPath ?? process.env.ADMIN_PATH);
  const adminAllowedIps = resolveAllowedIps(
    options.adminAllowedIps ?? process.env.ADMIN_ALLOWED_IPS
  );
  const enforceAdminIp = createAdminIpAllowlist(adminAllowedIps);
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
  app.set('etag', false);

  const useProxy = Boolean(
    options.trustProxy || process.env.TRUST_PROXY === 'true' || isProduction
  );
  if (useProxy) {
    app.set('trust proxy', 1);
  }

  // Cabeceras HTTP de máxima seguridad (Helmet + aislamiento cross-origin)
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
      frameguard: { action: 'deny' },
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      crossOriginEmbedderPolicy: false,
      hsts: isProduction
        ? { maxAge: 31536000, includeSubDomains: true, preload: false }
        : false,
    })
  );

  app.use(applyHardenedHeaders);

  // Límite estricto de payload JSON (32 KB) para evitar abusos de memoria
  app.use(express.json({ limit: '32kb', strict: true }));
  app.use(sanitizeIncomingPayload);

  // Sesión administrativa endurecida (HttpOnly + SameSite Strict + Secure en HTTPS)
  app.use(
    session({
      name: 'fesc_admin.sid',
      secret: sessionSecret,
      proxy: useProxy,
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

  // Endpoint ligero de salud para balanceadores y plataformas en la nube (Railway, Render, Docker)
  app.get('/health', preventSensitiveCaching, async (req, res) => {
    try {
      await db.get('SELECT 1 AS ok');
      return res.status(200).json({ ok: true, status: 'healthy', database: 'connected' });
    } catch {
      return res.status(503).json({ ok: false, status: 'unhealthy', database: 'disconnected' });
    }
  });

  // Librerías locales de Bootstrap 5 y Bootstrap Icons (sin CDN externos)
  app.use(
    '/vendor/bootstrap',
    express.static(BOOTSTRAP_DIST_DIR, { dotfiles: 'ignore', index: false })
  );
  app.use(
    '/vendor/bootstrap-icons',
    express.static(BOOTSTRAP_ICONS_DIR, { dotfiles: 'ignore', index: false })
  );

  const limiters = createRateLimiters({
    disableRateLimit: Boolean(options.disableRateLimit),
  });

  // Protección común para toda la API: anti-caché, anti-cross-site y rate limit global
  app.use('/api', preventSensitiveCaching, enforceApiIsolation, limiters.apiGlobalLimiter);

  if (enablePublic) {
    app.use('/api/public', createPublicRouter(db, limiters));
  }

  if (enableAdmin) {
    app.use(
      '/api/admin',
      enforceAdminIp,
      createAdminRouter(db, {
        timeoutMinutes: sessionTimeoutMinutes,
        limiters,
      })
    );
  }

  app.use('/api', notFoundHandler);

  // Bloquear acceso directo a /admin.html siempre (evita evadir ADMIN_PATH o APP_MODE)
  app.get('/admin.html', (req, res) => {
    res.status(404).type('text/plain').send('Not Found');
  });

  // Montar el panel administrativo únicamente en la ruta privada configurada (ADMIN_PATH)
  if (enableAdmin) {
    app.get(adminPath, enforceAdminIp, preventSensitiveCaching, (req, res) => {
      res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
    });
  }

  if (enablePublic) {
    app.get('/', (req, res) => {
      res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
    });
  }

  app.use(express.static(PUBLIC_DIR, { dotfiles: 'ignore', index: false }));

  app.use(errorHandler);

  return { app, db, adminPath, appMode };
}

module.exports = {
  createApp,
};
