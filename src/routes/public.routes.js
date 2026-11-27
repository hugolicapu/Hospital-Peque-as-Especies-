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

function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || '';
}

function createPublicRouter(db, limiters) {
  const router = express.Router();

  router.get('/config', async (req, res, next) => {
    try {
      const config = await getPublicConfig(db);
      res.json({ ok: true, data: config });
    } catch (err) {
      next(err);
    }
  });

  router.get('/availability', async (req, res, next) => {
    try {
      const dateStr = String(req.query.date || '').trim();
      const availability = await getAvailabilityForDate(db, dateStr);
      res.json({ ok: true, data: availability });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    '/appointments',
    limiters.publicAppointmentLimiter,
    async (req, res, next) => {
      try {
        const parsed = createAppointmentSchema.parse(req.body);
        const appointment = await createPublicAppointment(db, parsed);
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

  router.get(
    '/appointments/lookup',
    limiters.publicLookupLimiter,
    async (req, res, next) => {
      try {
        const parsed = lookupAppointmentSchema.parse({
          folio: req.query.folio,
          phone: req.query.phone,
        });
        const appointment = await lookupAppointment(db, parsed.folio, parsed.phone);
        res.json({ ok: true, data: appointment });
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    '/appointments/cancel',
    limiters.publicLookupLimiter,
    async (req, res, next) => {
      try {
        const parsed = lookupAppointmentSchema.parse(req.body);
        const cancelled = await cancelPublicAppointment(
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
