/**
 * @file src/middleware/security.middleware.js
 * @description Capas adicionales de defensa en profundidad para prevenir robo
 * de sesiones, filtración de datos personales (PII), ataques cross-site y
 * contaminación de prototipos/parámetros (HPP / Prototype Pollution).
 */

const crypto = require('node:crypto');
const { AppError } = require('./error.middleware');

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Recorre recursivamente un objeto JSON buscando llaves peligrosas de
 * Prototype Pollution (`__proto__`, `constructor`, `prototype`).
 *
 * @param {unknown} value
 * @param {number} [depth=0]
 * @returns {boolean}
 */
function hasForbiddenKeys(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 10) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((item) => hasForbiddenKeys(item, depth + 1));
  }

  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return true;
    }
    if (hasForbiddenKeys(value[key], depth + 1)) {
      return true;
    }
  }
  return false;
}

/**
 * Calcula un hash SHA-256 del encabezado `User-Agent` para vincular la sesión
 * administrativa al navegador donde se inició sesión (mitigación contra robo de cookie).
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function hashClientFingerprint(req) {
  const userAgent = String(req.get('user-agent') || 'unknown').slice(0, 300);
  return crypto.createHash('sha256').update(userAgent).digest('hex');
}

/**
 * Aplica cabeceras globales de aislamiento y restricción de permisos del navegador
 * (`Permissions-Policy` y `X-Permitted-Cross-Domain-Policies`).
 */
function applyHardenedHeaders(req, res, next) {
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), interest-cohort=()'
  );
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  return next();
}

/**
 * Impide que navegadores, proxies o discos compartidos almacenen en caché
 * respuestas que contienen datos personales (PII), tokens CSRF o información
 * administrativa, además de bloquear indexación por buscadores.
 */
function preventSensitiveCaching(req, res, next) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  return next();
}

/**
 * Bloquea solicitudes entre sitios (`Sec-Fetch-Site: cross-site`) hacia la API
 * y exige `Content-Type: application/json` en métodos de escritura para evitar
 * CSRF silenciosos y exfiltración desde sitios externos.
 */
function enforceApiIsolation(req, res, next) {
  const fetchSite = String(req.get('sec-fetch-site') || '').toLowerCase();
  if (fetchSite === 'cross-site') {
    return next(
      new AppError(
        'Solicitud bloqueada por política de seguridad: no se permiten peticiones desde sitios externos.',
        403
      )
    );
  }

  const method = req.method.toUpperCase();
  const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  const contentLength = Number.parseInt(req.get('content-length') || '0', 10);

  if (isMutation && contentLength > 0 && !req.is('application/json')) {
    return next(
      new AppError(
        'Tipo de contenido no permitido. La API acepta únicamente JSON.',
        415
      )
    );
  }

  return next();
}

/**
 * Inspecciona `req.body`, `req.query` y `req.params` para bloquear intentos de
 * Prototype Pollution y HTTP Parameter Pollution (parámetros duplicados en query).
 */
function sanitizeIncomingPayload(req, res, next) {
  if (hasForbiddenKeys(req.body) || hasForbiddenKeys(req.query) || hasForbiddenKeys(req.params)) {
    return next(
      new AppError('La solicitud contiene propiedades no permitidas.', 400)
    );
  }

  if (req.query && typeof req.query === 'object') {
    for (const value of Object.values(req.query)) {
      if (Array.isArray(value)) {
        return next(
          new AppError('Parámetros de consulta duplicados no permitidos.', 400)
        );
      }
    }
  }

  return next();
}

/**
 * Normaliza una IP eliminando el prefijo IPv4-mapeado en IPv6 (`::ffff:127.0.0.1` -> `127.0.0.1`).
 *
 * @param {string} rawIp
 * @returns {string}
 */
function normalizeIp(rawIp) {
  const cleaned = String(rawIp || '').trim();
  if (cleaned.startsWith('::ffff:')) {
    return cleaned.slice(7);
  }
  return cleaned;
}

/**
 * Crea un middleware de restricción opcional por lista blanca de IPs (`ADMIN_ALLOWED_IPS`).
 * Si la lista está vacía, permite acceso desde cualquier IP (ideal para administrar desde celular).
 * Si contiene IPs, devuelve `404` a conexiones no autorizadas para no revelar la existencia del panel.
 *
 * @param {string[]} allowedIps
 * @returns {import('express').RequestHandler}
 */
function createAdminIpAllowlist(allowedIps = []) {
  const normalizedSet = new Set(
    allowedIps.map((ip) => normalizeIp(ip)).filter((ip) => ip.length > 0)
  );

  if (normalizedSet.size === 0) {
    return function allowAllAdminIps(req, res, next) {
      return next();
    };
  }

  return function enforceAdminIpAllowlist(req, res, next) {
    const clientIp = normalizeIp(req.ip || req.socket?.remoteAddress || '');
    if (!normalizedSet.has(clientIp)) {
      if (req.originalUrl.startsWith('/api/')) {
        return res.status(404).json({
          ok: false,
          error: 'El recurso solicitado no existe.',
        });
      }
      return res.status(404).type('text/plain').send('Not Found');
    }
    return next();
  };
}

module.exports = {
  hashClientFingerprint,
  applyHardenedHeaders,
  preventSensitiveCaching,
  enforceApiIsolation,
  sanitizeIncomingPayload,
  createAdminIpAllowlist,
};
