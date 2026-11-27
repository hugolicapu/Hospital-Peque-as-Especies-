/**
 * @file src/middleware/auth.middleware.js
 * @description Middleware de protección para las rutas privadas del panel de
 * administrador único (`/api/admin/*`).
 *
 * Verifica tres condiciones en cada solicitud protegida:
 * 1. La sesión HTTP tiene marcada la bandera `adminAuthenticated = true`.
 * 2. No ha transcurrido más tiempo de inactividad que `timeoutMinutes`.
 * 3. El `req.sessionID` coincide exactamente con `admin_account.active_session_id`
 *    (garantía de sesión exclusiva única).
 */

const { SECURITY_CONFIG } = require('../config/constants');
const {
  validateActiveSession,
  clearActiveSession,
} = require('../services/auth.service');

/**
 * Crea el middleware de autenticación administrativa ligado a la base de datos
 * y a un tiempo máximo de inactividad configurable.
 *
 * @param {object} db Adaptador unificado (MySQL/XAMPP o SQLite).
 * @param {number} [timeoutMinutes=15] Minutos máximos de inactividad permitidos.
 * @returns {import('express').RequestHandler}
 */
function requireAdminAuth(
  db,
  timeoutMinutes = SECURITY_CONFIG.DEFAULT_SESSION_TIMEOUT_MINUTES
) {
  const maxIdleMs = Math.max(1, Number(timeoutMinutes)) * 60 * 1000;

  return async function adminAuthMiddleware(req, res, next) {
    try {
      if (!req.session || req.session.adminAuthenticated !== true) {
        return res.status(401).json({
          ok: false,
          error: 'Debes iniciar sesión como administrador para acceder a este recurso.',
        });
      }

      const now = Date.now();
      const lastActivity = Number(req.session.lastActivity || 0);

      // Verificar expiración por inactividad
      if (!lastActivity || now - lastActivity > maxIdleMs) {
        const username = req.session.adminUsername || 'admin';
        const sessionId = req.sessionID;
        const ipAddress = req.ip || req.socket?.remoteAddress || '';

        await clearActiveSession(
          db,
          sessionId,
          username,
          ipAddress,
          'Sesión cerrada automáticamente por inactividad.'
        );

        return req.session.destroy(() => {
          res.clearCookie('fesc_admin.sid');
          res.status(401).json({
            ok: false,
            error:
              'Tu sesión expiró por inactividad. Por seguridad, inicia sesión nuevamente.',
          });
        });
      }

      // Verificar que esta sesión siga siendo la única activa en base de datos
      const isValidSession = await validateActiveSession(db, req.sessionID);
      if (!isValidSession) {
        return req.session.destroy(() => {
          res.clearCookie('fesc_admin.sid');
          res.status(401).json({
            ok: false,
            error:
              'Tu sesión fue cerrada porque se inició sesión desde otro navegador o dispositivo.',
          });
        });
      }

      // Renovar marca de última actividad tras superar todas las validaciones
      req.session.lastActivity = now;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = {
  requireAdminAuth,
};
