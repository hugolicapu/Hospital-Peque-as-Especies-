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
const { hashClientFingerprint } = require('../middleware/security.middleware');
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

function createAdminRouter(db, { timeoutMinutes, limiters }) {
  const router = express.Router();
  const requireAuth = requireAdminAuth(db, timeoutMinutes);
  const maxIdleMs = Math.max(1, Number(timeoutMinutes)) * 60 * 1000;

  router.get('/csrf-token', (req, res, next) => {
    try {
      const csrfToken = ensureCsrfToken(req);
      res.json({ ok: true, data: { csrfToken } });
    } catch (err) {
      next(err);
    }
  });

  router.get('/session', async (req, res, next) => {
    try {
      const csrfToken = ensureCsrfToken(req);
      const adminConfigured = await isAdminConfigured(db);
      let authenticated = false;

      if (req.session.adminAuthenticated === true) {
        const now = Date.now();
        const lastActivity = Number(req.session.lastActivity || 0);
        const withinTimeout = Boolean(lastActivity && now - lastActivity <= maxIdleMs);
        const sessionIsActive = await validateActiveSession(db, req.sessionID);

        if (withinTimeout && sessionIsActive) {
          authenticated = true;
        } else {
          if (!withinTimeout && sessionIsActive) {
            await clearActiveSession(
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
    return req.session.regenerate(async (regenErr) => {
      if (regenErr) {
        return next(
          new AppError('No fue posible iniciar una sesión segura. Intenta de nuevo.', 500)
        );
      }

      try {
        const result = await verifyAdminLogin(db, {
          username: parsed.username,
          password: parsed.password,
          sessionId: req.sessionID,
          ipAddress,
        });

        req.session.adminAuthenticated = true;
        req.session.adminUsername = result.username;
        req.session.lastActivity = Date.now();
        req.session.uaHash = hashClientFingerprint(req);
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
        req.session.csrfToken = previousCsrfToken;
        return req.session.save(() => next(loginErr));
      }
    });
  });

  router.post('/logout', requireAuth, verifyCsrf, async (req, res, next) => {
    try {
      await clearActiveSession(
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

  router.post('/change-password', limiters.adminMutationLimiter, requireAuth, verifyCsrf, async (req, res, next) => {
    try {
      const parsed = changePasswordSchema.parse(req.body);
      await changeAdminPassword(db, {
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

  router.get('/dashboard', requireAuth, async (req, res, next) => {
    try {
      const dashboard = await getAdminDashboard(db, req.query.date);
      res.json({ ok: true, data: dashboard });
    } catch (err) {
      next(err);
    }
  });

  router.get('/appointments', requireAuth, async (req, res, next) => {
    try {
      const appointments = await listAdminAppointments(db, {
        date: req.query.date,
        status: req.query.status,
        search: req.query.search,
      });
      res.json({ ok: true, data: appointments });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/appointments/:id', limiters.adminMutationLimiter, requireAuth, verifyCsrf, async (req, res, next) => {
    try {
      const id = parsePositiveId(req.params.id, 'cita');
      const parsed = updateAppointmentSchema.parse(req.body);
      const updated = await updateAdminAppointment(
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

  router.get('/schedule', requireAuth, async (req, res, next) => {
    try {
      const schedule = await getScheduleConfig(db);
      res.json({ ok: true, data: schedule });
    } catch (err) {
      next(err);
    }
  });

  router.put('/schedule/rules', limiters.adminMutationLimiter, requireAuth, verifyCsrf, async (req, res, next) => {
    try {
      const parsed = scheduleRulesSchema.parse(req.body);
      const rules = await updateScheduleRules(
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

  router.post('/schedule/blocks', limiters.adminMutationLimiter, requireAuth, verifyCsrf, async (req, res, next) => {
    try {
      const parsed = blockDateSchema.parse(req.body);
      const block = await addBlockedDate(
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

  router.delete('/schedule/blocks/:id', limiters.adminMutationLimiter, requireAuth, verifyCsrf, async (req, res, next) => {
    try {
      const id = parsePositiveId(req.params.id, 'bloqueo');
      const removed = await removeBlockedDate(
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

  router.patch('/services/:id', limiters.adminMutationLimiter, requireAuth, verifyCsrf, async (req, res, next) => {
    try {
      const id = parsePositiveId(req.params.id, 'servicio');
      const parsed = updateServiceSchema.parse(req.body);
      const updated = await updateService(
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

  router.get('/audit-logs', requireAuth, async (req, res, next) => {
    try {
      const logs = await getRecentAuditLogs(db, req.query.limit);
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
