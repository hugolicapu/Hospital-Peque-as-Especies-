/**
 * @file src/routes/public.routes.js
 * @description Rutas HTTP del portal público de citas (`/api/public/*`).
 * Permite a cualquier tutor consultar horarios disponibles, agendar citas,
 * consultar su cita mediante folio + teléfono y cancelar su cita.
 */

const express = require('express');
const {
  createAppointmentSchema,
  lookupAppointmentSchema,
} = require('../validators/appointment.validator');
const {
  getPublicConfig,
  getAvailabilityForDate,
} = require('../services/schedule.service');
const {
  createPublicAppointment,
  lookupAppointment,
  cancelPublicAppointment,
} = require('../services/appointment.service');

/**
 * Extrae la IP del cliente para trazabilidad en auditoría de cancelaciones.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || '';
}

/**
 * Construye el router público de la API.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ publicAppointmentLimiter: import('express').RequestHandler, publicLookupLimiter: import('express').RequestHandler }} limiters
 * @returns {import('express').Router}
 */
function createPublicRouter(db, limiters) {
  const router = express.Router();

  /**
   * GET /api/public/config
   * Devuelve datos del hospital, especies atendidas, servicios activos y reglas de horario.
   */
  router.get('/config', (req, res, next) => {
    try {
      const config = getPublicConfig(db);
      res.json({ ok: true, data: config });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/public/availability?date=YYYY-MM-DD
   * Calcula las franjas disponibles y cupos restantes para una fecha específica.
   */
  router.get('/availability', (req, res, next) => {
    try {
      const dateStr = String(req.query.date || '').trim();
      const availability = getAvailabilityForDate(db, dateStr);
      res.json({ ok: true, data: availability });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/public/appointments
   * Valida datos del tutor/mascota y reserva la cita atómicamente evitando doble reserva.
   */
  router.post(
    '/appointments',
    limiters.publicAppointmentLimiter,
    (req, res, next) => {
      try {
        const parsed = createAppointmentSchema.parse(req.body);
        const appointment = createPublicAppointment(db, parsed);
        res.status(201).json({
          ok: true,
          message: '¡Tu cita ha sido registrada correctamente!',
          data: appointment,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /api/public/appointments/lookup?folio=...&phone=...
   * Consulta los datos públicos de una cita existente (sin notas internas del administrador).
   */
  router.get(
    '/appointments/lookup',
    limiters.publicLookupLimiter,
    (req, res, next) => {
      try {
        const parsed = lookupAppointmentSchema.parse({
          folio: req.query.folio,
          phone: req.query.phone,
        });
        const appointment = lookupAppointment(db, parsed.folio, parsed.phone);
        res.json({ ok: true, data: appointment });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * POST /api/public/appointments/cancel
   * Cancela una cita pendiente o confirmada validando folio y teléfono del tutor.
   */
  router.post(
    '/appointments/cancel',
    limiters.publicLookupLimiter,
    (req, res, next) => {
      try {
        const parsed = lookupAppointmentSchema.parse(req.body);
        const cancelled = cancelPublicAppointment(
          db,
          parsed.folio,
          parsed.phone,
          getClientIp(req)
        );
        res.json({
          ok: true,
          message: 'Tu cita ha sido cancelada y el horario quedó liberado.',
          data: cancelled,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

module.exports = {
  createPublicRouter,
};
