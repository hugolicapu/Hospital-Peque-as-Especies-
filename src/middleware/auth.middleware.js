/**
 * @file src/middleware/auth.middleware.js
 * @description Middleware de protección para las rutas privadas del panel de
 * administrador único (`/api/admin/*`).
 *
 * Verifica cuatro condiciones en cada solicitud protegida:
 * 1. La sesión HTTP tiene marcada la bandera `adminAuthenticated = true`.
 * 2. La huella del navegador (`uaHash`) coincide con la sesión original (anti-secuestro de cookie).
 * 3. No ha transcurrido más tiempo de inactividad que `timeoutMinutes`.
 * 4. El `req.sessionID` coincide exactamente con `admin_account.active_session_id`
 *    (garantía de sesión exclusiva única).
 */

const crypto = require('node:crypto');
const { SECURITY_CONFIG } = require('../config/constants');
const {
  validateActiveSession,
  clearActiveSession,
} = require('../services/auth.service');
const { logAuditEvent } = require('../services/audit.service');
const { hashClientFingerprint } = require('./security.middleware');

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

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

      const username = req.session.adminUsername || 'admin';
      const sessionId = req.sessionID;
      const ipAddress = req.ip || req.socket?.remoteAddress || '';

      // Verificar vinculación con el navegador original para mitigar robo de cookie de sesión
      const currentUaHash = hashClientFingerprint(req);
      if (req.session.uaHash && !safeEqualHex(req.session.uaHash, currentUaHash)) {
        await logAuditEvent(db, {
          eventType: 'ADMIN_SESSION_HIJACK_SUSPECTED',
          actor: username,
          ipAddress,
          details: 'Sesión revocada: la huella del navegador no coincide con el inicio de sesión original.',
        });
        await clearActiveSession(
          db,
          sessionId,
          username,
          ipAddress,
          'Sesión revocada automáticamente por cambio sospechoso de navegador.'
        );
        return req.session.destroy(() => {
          res.clearCookie('fesc_admin.sid');
          res.status(401).json({
            ok: false,
            error:
              'Por seguridad, tu sesión fue revocada al detectarse un cambio inesperado en el dispositivo.',
          });
        });
      }

      const now = Date.now();
      const lastActivity = Number(req.session.lastActivity || 0);

      // Verificar expiración por inactividad
      if (!lastActivity || now - lastActivity > maxIdleMs) {
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
