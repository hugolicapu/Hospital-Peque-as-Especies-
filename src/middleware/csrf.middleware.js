/**
 * @file src/middleware/csrf.middleware.js
 * @description Protección contra falsificación de peticiones entre sitios (CSRF)
 * para todas las operaciones que modifican estado en `/api/admin/*`.
 *
 * Mecanismo de defensa en profundidad:
 * 1. Token criptográfico aleatorio por sesión (`req.session.csrfToken`) validado
 *    en tiempo constante contra el encabezado `X-CSRF-Token`.
 * 2. Verificación del encabezado `Origin` (cuando está presente) para confirmar
 *    que la solicitud proviene del mismo host que sirve la aplicación.
 */

const crypto = require('node:crypto');
const { AppError } = require('./error.middleware');

/**
 * Garantiza que la sesión actual tenga un token CSRF criptográficamente seguro.
 * Si no existe aún, genera uno nuevo de 256 bits en hexadecimal.
 *
 * @param {import('express').Request} req
 * @returns {string} Token CSRF vigente en la sesión.
 */
function ensureCsrfToken(req) {
  if (!req.session) {
    throw new AppError('No fue posible inicializar la sesión de seguridad.', 500);
  }
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

/**
 * Genera y reemplaza el token CSRF de la sesión (se usa tras login o cambio de contraseña).
 *
 * @param {import('express').Request} req
 * @returns {string} Nuevo token CSRF.
 */
function rotateCsrfToken(req) {
  if (!req.session) {
    throw new AppError('No fue posible rotar el token de seguridad.', 500);
  }
  req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  return req.session.csrfToken;
}

/**
 * Middleware Express que valida el encabezado `Origin` y el token `X-CSRF-Token`
 * usando comparación en tiempo constante (`crypto.timingSafeEqual`).
 */
function verifyCsrf(req, res, next) {
  // 1. Verificar Origin si el navegador lo incluyó en la solicitud
  const originHeader = req.get('origin');
  if (originHeader) {
    const expectedHost = req.get('host');
    try {
      const parsedOrigin = new URL(originHeader);
      if (!expectedHost || parsedOrigin.host !== expectedHost) {
        return next(
          new AppError('Solicitud rechazada: el origen no está autorizado.', 403)
        );
      }
    } catch {
      return next(
        new AppError('Solicitud rechazada: encabezado de origen inválido.', 403)
      );
    }
  }

  // 2. Verificar token CSRF en tiempo constante
  const headerToken = req.get('x-csrf-token');
  const sessionToken = req.session?.csrfToken;

  if (
    typeof headerToken !== 'string' ||
    typeof sessionToken !== 'string' ||
    headerToken.length === 0 ||
    sessionToken.length === 0
  ) {
    return next(
      new AppError(
        'Token de seguridad CSRF faltante o expirado. Recarga la página e intenta nuevamente.',
        403
      )
    );
  }

  const headerBuf = Buffer.from(headerToken, 'utf8');
  const sessionBuf = Buffer.from(sessionToken, 'utf8');

  if (
    headerBuf.length !== sessionBuf.length ||
    !crypto.timingSafeEqual(headerBuf, sessionBuf)
  ) {
    return next(
      new AppError(
        'Token de seguridad CSRF inválido. Recarga la página e intenta nuevamente.',
        403
      )
    );
  }

  return next();
}

module.exports = {
  ensureCsrfToken,
  rotateCsrfToken,
  verifyCsrf,
};
