/**
 * @file src/middleware/csrf.middleware.js
 * @description Protección contra falsificación de peticiones entre sitios (CSRF)
 * para todas las operaciones que modifican estado en `/api/admin/*`.
 *
 * Mecanismo de defensa en profundidad:
 * 1. Bloqueo por Fetch Metadata (`Sec-Fetch-Site`) cuando el navegador indica origen externo.
 * 2. Verificación del encabezado `Origin` (o `Referer` como respaldo) contra el `Host` actual.
 * 3. Token criptográfico aleatorio por sesión (`req.session.csrfToken`) validado
 *    en tiempo constante (`crypto.timingSafeEqual`) contra `X-CSRF-Token`.
 */

const crypto = require('node:crypto');
const { AppError } = require('./error.middleware');

function ensureCsrfToken(req) {
  if (!req.session) {
    throw new AppError('No fue posible inicializar la sesión de seguridad.', 500);
  }
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

function rotateCsrfToken(req) {
  if (!req.session) {
    throw new AppError('No fue posible rotar el token de seguridad.', 500);
  }
  req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  return req.session.csrfToken;
}

function verifyCsrf(req, res, next) {
  // 1. Verificar Fetch Metadata si el navegador la envió
  const fetchSite = String(req.get('sec-fetch-site') || '').toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return next(
      new AppError('Solicitud rechazada: origen externo no autorizado.', 403)
    );
  }

  // 2. Verificar Origin (o Referer si Origin no viene) contra Host esperado
  const expectedHost = req.get('host');
  const originHeader = req.get('origin');
  const refererHeader = req.get('referer');

  if (originHeader) {
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
  } else if (refererHeader) {
    try {
      const parsedReferer = new URL(refererHeader);
      if (!expectedHost || parsedReferer.host !== expectedHost) {
        return next(
          new AppError('Solicitud rechazada: referencia de origen no autorizada.', 403)
        );
      }
    } catch {
      return next(
        new AppError('Solicitud rechazada: encabezado de referencia inválido.', 403)
      );
    }
  }

  // 3. Verificar token CSRF en tiempo constante
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
