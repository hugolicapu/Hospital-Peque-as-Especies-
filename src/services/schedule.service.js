/**
 * @file src/services/schedule.service.js
 * @description Lógica de negocio para reglas semanales de atención, fechas o
 * franjas bloqueadas, catálogo de servicios y cálculo de disponibilidad real
 * por fecha para el portal público y el panel de administrador.
 */

const { HOSPITAL_INFO, PET_SPECIES } = require('../config/constants');
const { withTransaction } = require('../db/database');
const { AppError } = require('../middleware/error.middleware');
const { isValidDateString } = require('../validators/appointment.validator');
const { logAuditEvent } = require('./audit.service');

/**
 * Devuelve la fecha local actual del servidor en formato `AAAA-MM-DD`.
 * Se usa fecha local (y no UTC) para evitar desfases al final del día en México.
 *
 * @returns {string}
 */
function getTodayDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Convierte `AAAA-MM-DD` a un objeto Date en medianoche local.
 *
 * @param {string} dateStr
 * @returns {Date}
 */
function parseLocalDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/**
 * Calcula cuántos días de diferencia hay entre `dateStr` y el día de hoy local.
 * Negativo = pasado, 0 = hoy, positivo = futuro.
 *
 * @param {string} dateStr
 * @returns {number}
 */
function diffDaysFromToday(dateStr) {
  const today = parseLocalDate(getTodayDateString());
  const target = parseLocalDate(dateStr);
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((target.getTime() - today.getTime()) / msPerDay);
}

/**
 * Obtiene el día de la semana (`0` = Domingo ... `6` = Sábado) de una fecha `AAAA-MM-DD`.
 *
 * @param {string} dateStr
 * @returns {number}
 */
function getDayOfWeek(dateStr) {
  return parseLocalDate(dateStr).getDay();
}

/**
 * Convierte `HH:MM` en minutos totales desde las 00:00.
 *
 * @param {string} hhmm
 * @returns {number}
 */
function timeToMinutes(hhmm) {
  const [hours, minutes] = hhmm.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Convierte minutos desde las 00:00 a formato `HH:MM`.
 *
 * @param {number} totalMinutes
 * @returns {string}
 */
function minutesToTime(totalMinutes) {
  const hours = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
  const minutes = String(totalMinutes % 60).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Genera la lista de horarios de inicio dentro de `[startTime, endTime]`
 * garantizando que cada bloque termine antes o exactamente a `endTime`.
 *
 * @param {string} startTime
 * @param {string} endTime
 * @param {number} slotMinutes
 * @returns {string[]}
 */
function generateTimeSlots(startTime, endTime, slotMinutes) {
  const start = timeToMinutes(startTime);
  const end = timeToMinutes(endTime);
  const slots = [];

  for (let current = start; current + slotMinutes <= end; current += slotMinutes) {
    slots.push(minutesToTime(current));
  }

  return slots;
}

function mapRuleRow(row) {
  return {
    dayOfWeek: row.day_of_week,
    isOpen: Boolean(row.is_open),
    startTime: row.start_time,
    endTime: row.end_time,
    slotMinutes: row.slot_minutes,
    capacityPerSlot: row.capacity_per_slot,
  };
}

function mapBlockedDateRow(row) {
  return {
    id: row.id,
    blockedDate: row.blocked_date,
    blockedTime: row.blocked_time || '',
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function mapServiceRow(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    durationMinutes: row.duration_minutes,
    active: Boolean(row.active),
  };
}

/**
 * Devuelve la configuración completa de agenda para el panel de administrador:
 * reglas de los 7 días, bloqueos registrados y todos los servicios (activos e inactivos).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
function getScheduleConfig(db) {
  const rules = db
    .prepare('SELECT * FROM schedule_rules ORDER BY day_of_week ASC')
    .all()
    .map(mapRuleRow);

  const blockedDates = db
    .prepare('SELECT * FROM blocked_dates ORDER BY blocked_date ASC, blocked_time ASC')
    .all()
    .map(mapBlockedDateRow);

  const services = db
    .prepare('SELECT * FROM services ORDER BY id ASC')
    .all()
    .map(mapServiceRow);

  return { rules, blockedDates, services };
}

/**
 * Devuelve la configuración pública para el portal de citas: datos del hospital,
 * especies atendidas, servicios activos, reglas de horario y anticipación máxima.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
function getPublicConfig(db) {
  const rules = db
    .prepare('SELECT * FROM schedule_rules ORDER BY day_of_week ASC')
    .all()
    .map(mapRuleRow);

  const services = db
    .prepare('SELECT * FROM services WHERE active = 1 ORDER BY id ASC')
    .all()
    .map(mapServiceRow);

  return {
    hospital: HOSPITAL_INFO,
    species: PET_SPECIES,
    services,
    schedule: rules,
    maxDaysAhead: HOSPITAL_INFO.maxDaysAhead,
  };
}

/**
 * Calcula la disponibilidad detallada de cada franja horaria para una fecha dada.
 *
 * Reglas evaluadas:
 * 1. Rechaza fechas con formato inválido, fechas pasadas o que superen `maxDaysAhead`.
 * 2. Verifica si el hospital abre ese día de la semana (`schedule_rules`).
 * 3. Verifica si existe un bloqueo de día completo o por horario (`blocked_dates`).
 * 4. Descuenta las citas activas (`pendiente` o `confirmada`) de la capacidad por bloque.
 * 5. Si la fecha es hoy, marca como no disponibles los horarios cuya hora ya transcurrió.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} dateStr Fecha en formato `AAAA-MM-DD`.
 * @returns {{ date: string, isOpen: boolean, dayBlocked: boolean, blockReason: string, slots: Array<{ time: string, available: number, capacity: number, isAvailable: boolean, reason: string }> }}
 */
function getAvailabilityForDate(db, dateStr) {
  if (!isValidDateString(dateStr)) {
    throw new AppError(
      'La fecha proporcionada no es válida. Usa el formato AAAA-MM-DD.',
      400
    );
  }

  const diffDays = diffDaysFromToday(dateStr);

  if (diffDays < 0) {
    return {
      date: dateStr,
      isOpen: false,
      dayBlocked: true,
      blockReason: 'No es posible agendar citas en fechas pasadas.',
      slots: [],
    };
  }

  if (diffDays > HOSPITAL_INFO.maxDaysAhead) {
    return {
      date: dateStr,
      isOpen: false,
      dayBlocked: true,
      blockReason: `Solo se pueden agendar citas con hasta ${HOSPITAL_INFO.maxDaysAhead} días de anticipación.`,
      slots: [],
    };
  }

  const dayOfWeek = getDayOfWeek(dateStr);
  const rule = db
    .prepare('SELECT * FROM schedule_rules WHERE day_of_week = ?')
    .get(dayOfWeek);

  if (!rule || !rule.is_open) {
    return {
      date: dateStr,
      isOpen: false,
      dayBlocked: false,
      blockReason: 'El hospital no brinda consulta en este día de la semana.',
      slots: [],
    };
  }

  const blocks = db
    .prepare('SELECT blocked_time, reason FROM blocked_dates WHERE blocked_date = ?')
    .all(dateStr);

  const fullDayBlock = blocks.find((b) => !b.blocked_time || b.blocked_time === '');
  if (fullDayBlock) {
    return {
      date: dateStr,
      isOpen: false,
      dayBlocked: true,
      blockReason: fullDayBlock.reason,
      slots: [],
    };
  }

  const slotBlocksMap = new Map();
  for (const block of blocks) {
    if (block.blocked_time) {
      slotBlocksMap.set(block.blocked_time, block.reason);
    }
  }

  // Contar citas activas (pendientes o confirmadas) que ocupan cupo ese día
  const counts = db
    .prepare(`
      SELECT appointment_time, COUNT(*) AS booked
      FROM appointments
      WHERE appointment_date = ?
        AND status IN ('pendiente', 'confirmada')
      GROUP BY appointment_time
    `)
    .all(dateStr);

  const bookedMap = new Map();
  for (const row of counts) {
    bookedMap.set(row.appointment_time, Number(row.booked));
  }

  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const isToday = diffDays === 0;

  const times = generateTimeSlots(rule.start_time, rule.end_time, rule.slot_minutes);
  const capacity = rule.capacity_per_slot;

  const slots = times.map((time) => {
    const blockedReason = slotBlocksMap.get(time);
    if (blockedReason) {
      return {
        time,
        available: 0,
        capacity,
        isAvailable: false,
        reason: blockedReason,
      };
    }

    // Si es hoy, no permitir agendar horarios cuya hora de inicio ya pasó
    if (isToday && timeToMinutes(time) <= currentMinutes) {
      return {
        time,
        available: 0,
        capacity,
        isAvailable: false,
        reason: 'Horario pasado',
      };
    }

    const booked = bookedMap.get(time) || 0;
    const available = Math.max(0, capacity - booked);

    if (available === 0) {
      return {
        time,
        available: 0,
        capacity,
        isAvailable: false,
        reason: 'Cupo lleno',
      };
    }

    return {
      time,
      available,
      capacity,
      isAvailable: true,
      reason: '',
    };
  });

  return {
    date: dateStr,
    isOpen: true,
    dayBlocked: false,
    blockReason: '',
    slots,
  };
}

/**
 * Actualiza de manera atómica las 7 reglas semanales de horario del hospital.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<{ dayOfWeek: number, isOpen: boolean, startTime: string, endTime: string, slotMinutes: number, capacityPerSlot: number }>} rules
 * @param {string} actor
 * @param {string} [ipAddress='']
 */
function updateScheduleRules(db, rules, actor, ipAddress = '') {
  withTransaction(db, () => {
    const stmt = db.prepare(`
      INSERT INTO schedule_rules (
        day_of_week, is_open, start_time, end_time, slot_minutes, capacity_per_slot
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(day_of_week) DO UPDATE SET
        is_open = excluded.is_open,
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        slot_minutes = excluded.slot_minutes,
        capacity_per_slot = excluded.capacity_per_slot
    `);

    for (const rule of rules) {
      stmt.run(
        rule.dayOfWeek,
        rule.isOpen ? 1 : 0,
        rule.startTime,
        rule.endTime,
        rule.slotMinutes,
        rule.capacityPerSlot
      );
    }

    logAuditEvent(db, {
      eventType: 'SCHEDULE_RULES_UPDATED',
      actor,
      ipAddress,
      details: 'Reglas semanales de horario actualizadas.',
    });
  });

  return db
    .prepare('SELECT * FROM schedule_rules ORDER BY day_of_week ASC')
    .all()
    .map(mapRuleRow);
}

/**
 * Agrega un bloqueo de día completo (`blockedTime = ''`) o de una franja específica.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ blockedDate: string, blockedTime?: string, reason: string }} payload
 * @param {string} actor
 * @param {string} [ipAddress='']
 */
function addBlockedDate(db, { blockedDate, blockedTime = '', reason }, actor, ipAddress = '') {
  const nowIso = new Date().toISOString();
  const normalizedTime = blockedTime || '';

  try {
    const info = db
      .prepare(`
        INSERT INTO blocked_dates (blocked_date, blocked_time, reason, created_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(blockedDate, normalizedTime, reason, nowIso);

    logAuditEvent(db, {
      eventType: 'SCHEDULE_BLOCK_ADDED',
      actor,
      ipAddress,
      details: `Bloqueo ${blockedDate}${normalizedTime ? ` ${normalizedTime}` : ' (día completo)'}: ${reason}`,
    });

    const created = db
      .prepare('SELECT * FROM blocked_dates WHERE id = ?')
      .get(info.lastInsertRowid);

    return mapBlockedDateRow(created);
  } catch (err) {
    if (String(err?.message || '').includes('UNIQUE')) {
      throw new AppError(
        'Esa fecha u horario ya se encuentra bloqueado actualmente.',
        409
      );
    }
    throw err;
  }
}

/**
 * Elimina un bloqueo de fecha u horario existente por su identificador.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @param {string} actor
 * @param {string} [ipAddress='']
 */
function removeBlockedDate(db, id, actor, ipAddress = '') {
  const existing = db.prepare('SELECT * FROM blocked_dates WHERE id = ?').get(id);
  if (!existing) {
    throw new AppError('El bloqueo indicado no existe.', 404);
  }

  db.prepare('DELETE FROM blocked_dates WHERE id = ?').run(id);

  logAuditEvent(db, {
    eventType: 'SCHEDULE_BLOCK_REMOVED',
    actor,
    ipAddress,
    details: `Bloqueo eliminado: ${existing.blocked_date}${existing.blocked_time ? ` ${existing.blocked_time}` : ' (día completo)'}.`,
  });

  return mapBlockedDateRow(existing);
}

/**
 * Actualiza los atributos editables de un servicio veterinario.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @param {{ active?: boolean, description?: string, durationMinutes?: number }} payload
 * @param {string} actor
 * @param {string} [ipAddress='']
 */
function updateService(db, id, payload, actor, ipAddress = '') {
  const existing = db.prepare('SELECT * FROM services WHERE id = ?').get(id);
  if (!existing) {
    throw new AppError('El servicio veterinario indicado no existe.', 404);
  }

  const nextActive =
    payload.active !== undefined ? (payload.active ? 1 : 0) : existing.active;
  const nextDescription =
    payload.description !== undefined ? payload.description : existing.description;
  const nextDuration =
    payload.durationMinutes !== undefined
      ? payload.durationMinutes
      : existing.duration_minutes;

  db.prepare(`
    UPDATE services
    SET active = ?, description = ?, duration_minutes = ?
    WHERE id = ?
  `).run(nextActive, nextDescription, nextDuration, id);

  logAuditEvent(db, {
    eventType: 'SERVICE_UPDATED',
    actor,
    ipAddress,
    details: `Servicio "${existing.name}" actualizado (activo=${Boolean(nextActive)}, duración=${nextDuration} min).`,
  });

  const updated = db.prepare('SELECT * FROM services WHERE id = ?').get(id);
  return mapServiceRow(updated);
}

module.exports = {
  getTodayDateString,
  getDayOfWeek,
  diffDaysFromToday,
  timeToMinutes,
  generateTimeSlots,
  getScheduleConfig,
  getPublicConfig,
  getAvailabilityForDate,
  updateScheduleRules,
  addBlockedDate,
  removeBlockedDate,
  updateService,
};
