/**
 * @file src/middleware/rateLimit.middleware.js
 * @description Limitadores de tasa (rate limiting) basados en `express-rate-limit`
 * para mitigar fuerza bruta en el login administrativo y abuso/spam en la
 * creación o consulta de citas públicas.
 */

const rateLimit = require('express-rate-limit');

/**
 * Middleware sin efecto utilizado exclusivamente cuando se desactiva el
 * rate limiting en pruebas automatizadas (`disableRateLimit: true`).
 */
function passthroughLimiter(req, res, next) {
  return next();
}

/**
 * Construye los limitadores de tasa usados por las rutas públicas y privadas.
 *
 * @param {{ disableRateLimit?: boolean }} [options]
 * @returns {{
 *   loginLimiter: import('express').RequestHandler,
 *   publicAppointmentLimiter: import('express').RequestHandler,
 *   publicLookupLimiter: import('express').RequestHandler
 * }}
 */
function createRateLimiters({ disableRateLimit = false } = {}) {
  if (disableRateLimit) {
    return {
      loginLimiter: passthroughLimiter,
      publicAppointmentLimiter: passthroughLimiter,
      publicLookupLimiter: passthroughLimiter,
    };
  }

  const fifteenMinutesMs = 15 * 60 * 1000;

  // Protección anti-fuerza bruta en el inicio de sesión del administrador único
  const loginLimiter = rateLimit({
    windowMs: fifteenMinutesMs,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      ok: false,
      error:
        'Demasiados intentos de inicio de sesión desde tu conexión. Espera 15 minutos e intenta nuevamente.',
    },
  });

  // Protección contra spam o saturación automática de la agenda pública
  const publicAppointmentLimiter = rateLimit({
    windowMs: fifteenMinutesMs,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      ok: false,
      error:
        'Has enviado demasiadas solicitudes de cita en poco tiempo. Espera unos minutos antes de volver a intentar.',
    },
  });

  // Protección contra enumeración de folios en consultas o cancelaciones públicas
  const publicLookupLimiter = rateLimit({
    windowMs: fifteenMinutesMs,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      ok: false,
      error:
        'Has realizado demasiadas consultas en poco tiempo. Espera unos minutos antes de intentar nuevamente.',
    },
  });

  return {
    loginLimiter,
    publicAppointmentLimiter,
    publicLookupLimiter,
  };
}

module.exports = {
  createRateLimiters,
};
