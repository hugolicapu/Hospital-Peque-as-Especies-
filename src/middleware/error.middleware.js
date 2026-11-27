/**
 * @file src/middleware/error.middleware.js
 * @description Clase de errores operacionales (AppError) y manejadores globales
 * de Express para responder siempre con el contrato JSON uniforme del sistema:
 * `{ ok: false, error, details? }`, sin exponer detalles técnicos ni stack traces.
 */

const { ZodError } = require('zod');

/**
 * Error controlado de la aplicación con código HTTP y detalles opcionales.
 * Se utiliza en servicios y middlewares para comunicar reglas de negocio
 * incumplidas (por ejemplo, horario ocupado, credenciales inválidas o folio inexistente).
 */
class AppError extends Error {
  /**
   * @param {string} message Mensaje claro en español orientado al usuario.
   * @param {number} [statusCode=500] Código de estado HTTP correspondiente.
   * @param {Array<{ field: string, message: string }>|null} [details=null] Lista opcional de errores por campo.
   */
  constructor(message, statusCode = 500, details = null) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

/**
 * Convierte un ZodError en la estructura plana de detalles exigida por el contrato API.
 *
 * @param {import('zod').ZodError} zodError
 * @returns {Array<{ field: string, message: string }>}
 */
function formatZodError(zodError) {
  return zodError.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : 'general',
    message: issue.message,
  }));
}

/**
 * Middleware para rutas bajo `/api/*` que no coinciden con ningún endpoint registrado.
 */
function notFoundHandler(req, res) {
  res.status(404).json({
    ok: false,
    error: 'El recurso solicitado no existe.',
  });
}

/**
 * Middleware global de manejo de errores de Express.
 * Traduce errores de validación (Zod), errores de negocio (AppError) y fallos
 * de parseo JSON a respuestas JSON seguras y consistentes.
 */
function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  // Errores de validación de esquemas Zod
  if (err instanceof ZodError || err?.name === 'ZodError') {
    const details = formatZodError(err);
    return res.status(400).json({
      ok: false,
      error: details[0]?.message || 'Algunos datos ingresados no son válidos.',
      details,
    });
  }

  // Errores de negocio explícitos lanzados por servicios o middlewares
  if (err instanceof AppError) {
    const payload = {
      ok: false,
      error: err.message,
    };
    if (err.details) {
      payload.details = err.details;
    }
    return res.status(err.statusCode).json(payload);
  }

  // Error al interpretar JSON mal formado en el cuerpo de la petición
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({
      ok: false,
      error: 'El formato de los datos enviados no es un JSON válido.',
    });
  }

  // Error cuando el cuerpo supera el límite configurado (50kb)
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({
      ok: false,
      error: 'La solicitud excede el tamaño máximo permitido.',
    });
  }

  // Error no esperado: se registra en consola del servidor sin revelar stack al cliente
  console.error('[ERROR INTERNO]', err);
  return res.status(500).json({
    ok: false,
    error: 'Ocurrió un error interno en el servidor. Intenta nuevamente en unos momentos.',
  });
}

module.exports = {
  AppError,
  formatZodError,
  notFoundHandler,
  errorHandler,
};
