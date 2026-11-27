/**
 * @file src/routes/admin.routes.js
 * @description Rutas HTTP protegidas del Panel de Administrador Único (`/api/admin/*`).
 *
 * Medidas de seguridad aplicadas:
 * - No existe ruta de registro de administradores (modelo estrictamente Single-Admin).
 * - Todo método de escritura (`POST`, `PUT`, `PATCH`, `DELETE`) exige `verifyCsrf`.
 * - `POST /login` regenera el ID de sesión (`req.session.regenerate`) antes de guardar
 *   `active_session_id` y rotar `csrfToken`, previniendo Session Fixation.
 * - Todas las rutas de gestión verifican sesión autenticada, timeout por inactividad
 *   y coincidencia exacta con `admin_account.active_session_id`.
 */

const express = require('express');
const { AppError } = require('../middleware/error.middleware');
const { requireAdminAuth } = require('../middleware/auth.middleware');
const {
  ensureCsrfToken,
  rotateCsrfToken,
  verifyCsrf,
} = require('../middleware/csrf.middleware');
const {
  loginSchema,
  changePasswordSchema,
  scheduleRulesSchema,
  blockDateSchema,
  updateServiceSchema,
} = require('../validators/admin.validator');
const { updateAppointmentSchema } = require('../validators/appointment.validator');
const {
  isAdminConfigured,
  verifyAdminLogin,
  validateActiveSession,
  clearActiveSession,
  changeAdminPassword,
} = require('../services/auth.service');
const {
  getScheduleConfig,
  updateScheduleRules,
  addBlockedDate,
  removeBlockedDate,
  updateService,
} = require('../services/schedule.service');
const {
  getAdminDashboard,
  listAdminAppointments,
  updateAdminAppointment,
} = require('../services/appointment.service');
const { getRecentAuditLogs } = require('../services/audit.service');

/**
 * Parsea un parámetro `:id` exigiendo un entero positivo válido.
 *
 * @param {string} rawId
 * @param {string} label Nombre legible del recurso para el mensaje de error.
 * @returns {number}
 */
function parsePositiveId(rawId, label = 'registro') {
  if (!/^\d+$/.test(String(rawId || ''))) {
    throw new AppError(`El identificador de ${label} no es válido.`, 400);
  }
  const id = Number.parseInt(rawId, 10);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AppError(`El identificador de ${label} no es válido.`, 400);
  }
  return id;
}

function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || '';
}

/**
 * Construye el router de administración.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ timeoutMinutes: number, limiters: { loginLimiter: import('express').RequestHandler } }} config
 * @returns {import('express').Router}
 */
function createAdminRouter(db, { timeoutMinutes, limiters }) {
  const router = express.Router();
  const requireAuth = requireAdminAuth(db, timeoutMinutes);
  const maxIdleMs = Math.max(1, Number(timeoutMinutes)) * 60 * 1000;

  /**
   * GET /api/admin/csrf-token
   * Devuelve el token CSRF ligado a la sesión actual (creándolo si no existe).
   */
  router.get('/csrf-token', (req, res, next) => {
    try {
      const csrfToken = ensureCsrfToken(req);
      res.json({ ok: true, data: { csrfToken } });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/admin/session
   * Informa el estado de sesión actual, si la cuenta única está configurada y el token CSRF.
   */
  router.get('/session', (req, res, next) => {
    try {
      const csrfToken = ensureCsrfToken(req);
      const adminConfigured = isAdminConfigured(db);
      let authenticated = false;

      if (req.session.adminAuthenticated === true) {
        const now = Date.now();
        const lastActivity = Number(req.session.lastActivity || 0);
        const withinTimeout = Boolean(lastActivity && now - lastActivity <= maxIdleMs);
        const sessionIsActive = validateActiveSession(db, req.sessionID);

        if (withinTimeout && sessionIsActive) {
          authenticated = true;
        } else {
          // Limpiar bandera local si la sesión venció por inactividad o fue reemplazada
          if (!withinTimeout && sessionIsActive) {
            clearActiveSession(
              db,
              req.sessionID,
              req.session.adminUsername || 'admin',
              getClientIp(req),
              'Sesión expirada por inactividad al consultar estado.'
            );
          }
          req.session.adminAuthenticated = false;
          delete req.session.adminUsername;
          delete req.session.lastActivity;
        }
      }

      const data = {
        authenticated,
        adminConfigured,
        timeoutMinutes,
        csrfToken,
      };

      if (authenticated) {
        data.username = req.session.adminUsername;
      }

      res.json({ ok: true, data });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/admin/login
   * Autentica al administrador único. Regenera el ID de sesión ANTES de guardar
   * `active_session_id` y rota el token CSRF para mitigar Session Fixation.
   */
  router.post('/login', limiters.loginLimiter, verifyCsrf, (req, res, next) => {
    let parsed;
    try {
      parsed = loginSchema.parse(req.body);
    } catch (err) {
      return next(err);
    }

    const previousCsrfToken = req.session.csrfToken;
    const ipAddress = getClientIp(req);

    // Regenerar sesión para prevenir ataques de Session Fixation
    return req.session.regenerate((regenErr) => {
      if (regenErr) {
        return next(
          new AppError('No fue posible iniciar una sesión segura. Intenta de nuevo.', 500)
        );
      }

      try {
        const result = verifyAdminLogin(db, {
          username: parsed.username,
          password: parsed.password,
          sessionId: req.sessionID,
          ipAddress,
        });

        req.session.adminAuthenticated = true;
        req.session.adminUsername = result.username;
        req.session.lastActivity = Date.now();
        const csrfToken = rotateCsrfToken(req);

        return req.session.save((saveErr) => {
          if (saveErr) {
            return next(
              new AppError('No fue posible guardar la sesión de administrador.', 500)
            );
          }

          return res.json({
            ok: true,
            message: result.replacedPreviousSession
              ? 'Inicio de sesión exitoso. Se cerró la sesión anterior activa.'
              : 'Inicio de sesión exitoso.',
            data: {
              username: result.username,
              csrfToken,
              timeoutMinutes,
              replacedPreviousSession: result.replacedPreviousSession,
            },
          });
        });
      } catch (loginErr) {
        // Conservamos el token CSRF vigente para permitir reintentar el formulario sin 403
        req.session.csrfToken = previousCsrfToken;
        return req.session.save(() => next(loginErr));
      }
    });
  });

  /**
   * POST /api/admin/logout
   * Cierra la sesión actual, limpia `active_session_id` y elimina la cookie.
   */
  router.post('/logout', requireAuth, verifyCsrf, (req, res, next) => {
    try {
      clearActiveSession(
        db,
        req.sessionID,
        req.session.adminUsername,
        getClientIp(req),
        'Cierre de sesión voluntario.'
      );

      req.session.destroy((destroyErr) => {
        if (destroyErr) {
          return next(new AppError('Error al cerrar la sesión.', 500));
        }
        res.clearCookie('fesc_admin.sid');
        return res.json({
          ok: true,
          message: 'Sesión cerrada correctamente.',
          data: null,
        });
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/admin/change-password
   * Permite actualizar la contraseña del administrador único cumpliendo la política fuerte.
   */
  router.post('/change-password', requireAuth, verifyCsrf, (req, res, next) => {
    try {
      const parsed = changePasswordSchema.parse(req.body);
      changeAdminPassword(db, {
        currentPassword: parsed.currentPassword,
        newPassword: parsed.newPassword,
        ipAddress: getClientIp(req),
      });

      const csrfToken = rotateCsrfToken(req);
      res.json({
        ok: true,
        message: 'Contraseña actualizada correctamente.',
        data: { csrfToken },
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/admin/dashboard?date=YYYY-MM-DD
   * Devuelve estadísticas y citas ordenadas cronológicamente para la fecha solicitada.
   */
  router.get('/dashboard', requireAuth, (req, res, next) => {
    try {
      const dashboard = getAdminDashboard(db, req.query.date);
      res.json({ ok: true, data: dashboard });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/admin/appointments?date=&status=&search=
   * Lista citas aplicando filtros de fecha, estado o búsqueda libre.
   */
  router.get('/appointments', requireAuth, (req, res, next) => {
    try {
      const appointments = listAdminAppointments(db, {
        date: req.query.date,
        status: req.query.status,
        search: req.query.search,
      });
      res.json({ ok: true, data: appointments });
    } catch (err) {
      next(err);
    }
  });

  /**
   * PATCH /api/admin/appointments/:id
   * Actualiza estado, fecha, horario o notas internas de una cita.
   */
  router.patch('/appointments/:id', requireAuth, verifyCsrf, (req, res, next) => {
    try {
      const id = parsePositiveId(req.params.id, 'cita');
      const parsed = updateAppointmentSchema.parse(req.body);
      const updated = updateAdminAppointment(
        db,
        id,
        parsed,
        req.session.adminUsername,
        getClientIp(req)
      );
      res.json({
        ok: true,
        message: 'Cita actualizada correctamente.',
        data: updated,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/admin/schedule
   * Devuelve las reglas semanales, bloqueos registrados y catálogo completo de servicios.
   */
  router.get('/schedule', requireAuth, (req, res, next) => {
    try {
      const schedule = getScheduleConfig(db);
      res.json({ ok: true, data: schedule });
    } catch (err) {
      next(err);
    }
  });

  /**
   * PUT /api/admin/schedule/rules
   * Actualiza la configuración semanal completa (los 7 días de la semana).
   */
  router.put('/schedule/rules', requireAuth, verifyCsrf, (req, res, next) => {
    try {
      const parsed = scheduleRulesSchema.parse(req.body);
      const rules = updateScheduleRules(
        db,
        parsed.rules,
        req.session.adminUsername,
        getClientIp(req)
      );
      res.json({
        ok: true,
        message: 'Horarios semanales actualizados correctamente.',
        data: { rules },
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/admin/schedule/blocks
   * Crea un bloqueo de día completo o de un horario específico.
   */
  router.post('/schedule/blocks', requireAuth, verifyCsrf, (req, res, next) => {
    try {
      const parsed = blockDateSchema.parse(req.body);
      const block = addBlockedDate(
        db,
        parsed,
        req.session.adminUsername,
        getClientIp(req)
      );
      res.status(201).json({
        ok: true,
        message: 'Bloqueo registrado correctamente.',
        data: block,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * DELETE /api/admin/schedule/blocks/:id
   * Elimina un bloqueo previamente registrado.
   */
  router.delete('/schedule/blocks/:id', requireAuth, verifyCsrf, (req, res, next) => {
    try {
      const id = parsePositiveId(req.params.id, 'bloqueo');
      const removed = removeBlockedDate(
        db,
        id,
        req.session.adminUsername,
        getClientIp(req)
      );
      res.json({
        ok: true,
        message: 'Bloqueo eliminado correctamente.',
        data: removed,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * PATCH /api/admin/services/:id
   * Activa/desactiva un servicio o edita su descripción y duración estimada.
   */
  router.patch('/services/:id', requireAuth, verifyCsrf, (req, res, next) => {
    try {
      const id = parsePositiveId(req.params.id, 'servicio');
      const parsed = updateServiceSchema.parse(req.body);
      const updated = updateService(
        db,
        id,
        parsed,
        req.session.adminUsername,
        getClientIp(req)
      );
      res.json({
        ok: true,
        message: 'Servicio actualizado correctamente.',
        data: updated,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/admin/audit-logs?limit=50
   * Consulta los eventos recientes de seguridad y administración.
   */
  router.get('/audit-logs', requireAuth, (req, res, next) => {
    try {
      const logs = getRecentAuditLogs(db, req.query.limit);
      res.json({ ok: true, data: logs });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = {
  createAdminRouter,
};
