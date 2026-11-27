/**
 * @file src/middleware/rateLimit.middleware.js
 * @description Limitadores de tasa (rate limiting) basados en `express-rate-limit`
 * para mitigar fuerza bruta, extracción masiva (scraping), enumeración de folios
 * y saturación de la agenda pública o del panel de administrador.
 */

const rateLimit = require('express-rate-limit');

function passthroughLimiter(req, res, next) {
  return next();
}

function createRateLimiters({ disableRateLimit = false } = {}) {
  if (disableRateLimit) {
    return {
      apiGlobalLimiter: passthroughLimiter,
      loginLimiter: passthroughLimiter,
      adminMutationLimiter: passthroughLimiter,
      publicAppointmentLimiter: passthroughLimiter,
      publicLookupLimiter: passthroughLimiter,
    };
  }

  const fifteenMinutesMs = 15 * 60 * 1000;

  // Tope global en toda la API contra scraping masivo o denegación de servicio ligera
  const apiGlobalLimiter = rateLimit({
    windowMs: fifteenMinutesMs,
    max: 240,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      ok: false,
      error:
        'Se detectaron demasiadas solicitudes desde tu conexión. Espera unos minutos e intenta de nuevo.',
    },
  });

  // Protección estricta anti-fuerza bruta en el inicio de sesión del administrador único
  const loginLimiter = rateLimit({
    windowMs: fifteenMinutesMs,
    max: 8,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      ok: false,
      error:
        'Demasiados intentos de inicio de sesión desde tu conexión. Espera 15 minutos e intenta nuevamente.',
    },
  });

  // Límite sobre operaciones de escritura en el panel administrativo
  const adminMutationLimiter = rateLimit({
    windowMs: fifteenMinutesMs,
    max: 80,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      ok: false,
      error:
        'Se superó el límite temporal de cambios administrativos. Espera unos minutos.',
    },
  });

  // Protección contra spam o saturación automática de la agenda pública
  const publicAppointmentLimiter = rateLimit({
    windowMs: fifteenMinutesMs,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      ok: false,
      error:
        'Has enviado demasiadas solicitudes de cita en poco tiempo. Espera unos minutos antes de volver a intentar.',
    },
  });

  // Protección estricta contra enumeración de folios o teléfonos en consultas/cancelaciones
  const publicLookupLimiter = rateLimit({
    windowMs: fifteenMinutesMs,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      ok: false,
      error:
        'Has realizado demasiadas consultas en poco tiempo. Por seguridad, espera unos minutos antes de reintentar.',
    },
  });

  return {
    apiGlobalLimiter,
    loginLimiter,
    adminMutationLimiter,
    publicAppointmentLimiter,
    publicLookupLimiter,
  };
}

module.exports = {
  createRateLimiters,
};
