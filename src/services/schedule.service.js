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
 * Zona horaria oficial del hospital (FES Cuautitlán, Estado de México).
 * Evita desfases de fecha/hora cuando la aplicación se despliega en servidores
 * en la nube configurados en UTC (Railway, Render, Fly.io, Docker, etc.).
 */
const HOSPITAL_TIMEZONE = process.env.HOSPITAL_TIMEZONE || 'America/Mexico_City';

/**
 * Obtiene la fecha (`AAAA-MM-DD`) y minutos transcurridos del día actual
 * en la zona horaria oficial del hospital.
 *
 * @returns {{ dateStr: string, minutesOfDay: number }}
 */
function getHospitalNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: HOSPITAL_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const hours = Number.parseInt(map.hour, 10) % 24;
  const minutes = Number.parseInt(map.minute, 10);
  return {
    dateStr: `${map.year}-${map.month}-${map.day}`,
    minutesOfDay: hours * 60 + minutes,
  };
}

function getTodayDateString() {
  return getHospitalNow().dateStr;
}

function parseLocalDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function diffDaysFromToday(dateStr) {
  const today = parseLocalDate(getTodayDateString());
  const target = parseLocalDate(dateStr);
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((target.getTime() - today.getTime()) / msPerDay);
}

function getDayOfWeek(dateStr) {
  return parseLocalDate(dateStr).getDay();
}

function timeToMinutes(hhmm) {
  const [hours, minutes] = hhmm.split(':').map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(totalMinutes) {
  const hours = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
  const minutes = String(totalMinutes % 60).padStart(2, '0');
  return `${hours}:${minutes}`;
}

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
    dayOfWeek: Number(row.day_of_week),
    isOpen: Boolean(row.is_open),
    startTime: String(row.start_time).slice(0, 5),
    endTime: String(row.end_time).slice(0, 5),
    slotMinutes: Number(row.slot_minutes),
    capacityPerSlot: Number(row.capacity_per_slot),
  };
}

function mapBlockedDateRow(row) {
  return {
    id: Number(row.id),
    blockedDate: row.blocked_date,
    blockedTime: row.blocked_time || '',
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function mapServiceRow(row) {
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description,
    icon: row.icon,
    durationMinutes: Number(row.duration_minutes),
    active: Boolean(row.active),
  };
}

async function getScheduleConfig(db) {
  const rules = (
    await db.all('SELECT * FROM schedule_rules ORDER BY day_of_week ASC')
  ).map(mapRuleRow);

  const blockedDates = (
    await db.all('SELECT * FROM blocked_dates ORDER BY blocked_date ASC, blocked_time ASC')
  ).map(mapBlockedDateRow);

  const services = (
    await db.all('SELECT * FROM services ORDER BY id ASC')
  ).map(mapServiceRow);

  return { rules, blockedDates, services };
}

async function getPublicConfig(db) {
  const rules = (
    await db.all('SELECT * FROM schedule_rules ORDER BY day_of_week ASC')
  ).map(mapRuleRow);

  const services = (
    await db.all('SELECT * FROM services WHERE active = 1 ORDER BY id ASC')
  ).map(mapServiceRow);

  return {
    hospital: HOSPITAL_INFO,
    species: PET_SPECIES,
    services,
    schedule: rules,
    maxDaysAhead: HOSPITAL_INFO.maxDaysAhead,
  };
}

async function getAvailabilityForDate(db, dateStr) {
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
  const rule = await db.get('SELECT * FROM schedule_rules WHERE day_of_week = ?', [dayOfWeek]);

  if (!rule || !rule.is_open) {
    return {
      date: dateStr,
      isOpen: false,
      dayBlocked: false,
      blockReason: 'El hospital no brinda consulta en este día de la semana.',
      slots: [],
    };
  }

  const blocks = await db.all(
    'SELECT blocked_time, reason FROM blocked_dates WHERE blocked_date = ?',
    [dateStr]
  );

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
      slotBlocksMap.set(String(block.blocked_time).slice(0, 5), block.reason);
    }
  }

  const counts = await db.all(
    `SELECT appointment_time, COUNT(*) AS booked
     FROM appointments
     WHERE appointment_date = ?
       AND status IN ('pendiente', 'confirmada')
     GROUP BY appointment_time`,
    [dateStr]
  );

  const bookedMap = new Map();
  for (const row of counts) {
    bookedMap.set(String(row.appointment_time).slice(0, 5), Number(row.booked));
  }

  const currentMinutes = getHospitalNow().minutesOfDay;
  const isToday = diffDays === 0;

  const times = generateTimeSlots(
    String(rule.start_time).slice(0, 5),
    String(rule.end_time).slice(0, 5),
    Number(rule.slot_minutes)
  );
  const capacity = Number(rule.capacity_per_slot);

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

async function updateScheduleRules(db, rules, actor, ipAddress = '') {
  await withTransaction(db, async (tx) => {
    const upsertSql =
      tx.dialect === 'mysql'
        ? `INSERT INTO schedule_rules (
             day_of_week, is_open, start_time, end_time, slot_minutes, capacity_per_slot
           )
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             is_open = VALUES(is_open),
             start_time = VALUES(start_time),
             end_time = VALUES(end_time),
             slot_minutes = VALUES(slot_minutes),
             capacity_per_slot = VALUES(capacity_per_slot)`
        : `INSERT INTO schedule_rules (
             day_of_week, is_open, start_time, end_time, slot_minutes, capacity_per_slot
           )
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(day_of_week) DO UPDATE SET
             is_open = excluded.is_open,
             start_time = excluded.start_time,
             end_time = excluded.end_time,
             slot_minutes = excluded.slot_minutes,
             capacity_per_slot = excluded.capacity_per_slot`;

    for (const rule of rules) {
      await tx.run(upsertSql, [
        rule.dayOfWeek,
        rule.isOpen ? 1 : 0,
        rule.startTime,
        rule.endTime,
        rule.slotMinutes,
        rule.capacityPerSlot,
      ]);
    }

    await logAuditEvent(tx, {
      eventType: 'SCHEDULE_RULES_UPDATED',
      actor,
      ipAddress,
      details: 'Reglas semanales de horario actualizadas.',
    });
  });

  return (await db.all('SELECT * FROM schedule_rules ORDER BY day_of_week ASC')).map(mapRuleRow);
}

async function addBlockedDate(db, { blockedDate, blockedTime = '', reason }, actor, ipAddress = '') {
  const nowIso = new Date().toISOString();
  const normalizedTime = blockedTime || '';

  try {
    const info = await db.run(
      `INSERT INTO blocked_dates (blocked_date, blocked_time, reason, created_at)
       VALUES (?, ?, ?, ?)`,
      [blockedDate, normalizedTime, reason, nowIso]
    );

    await logAuditEvent(db, {
      eventType: 'SCHEDULE_BLOCK_ADDED',
      actor,
      ipAddress,
      details: `Bloqueo ${blockedDate}${normalizedTime ? ` ${normalizedTime}` : ' (día completo)'}: ${reason}`,
    });

    const created = await db.get('SELECT * FROM blocked_dates WHERE id = ?', [
      info.lastInsertRowid,
    ]);
    return mapBlockedDateRow(created);
  } catch (err) {
    if (
      err?.code === 'ER_DUP_ENTRY' ||
      String(err?.message || '').includes('UNIQUE') ||
      String(err?.message || '').includes('Duplicate entry')
    ) {
      throw new AppError(
        'Esa fecha u horario ya se encuentra bloqueado actualmente.',
        409
      );
    }
    throw err;
  }
}

async function removeBlockedDate(db, id, actor, ipAddress = '') {
  const existing = await db.get('SELECT * FROM blocked_dates WHERE id = ?', [id]);
  if (!existing) {
    throw new AppError('El bloqueo indicado no existe.', 404);
  }

  await db.run('DELETE FROM blocked_dates WHERE id = ?', [id]);

  await logAuditEvent(db, {
    eventType: 'SCHEDULE_BLOCK_REMOVED',
    actor,
    ipAddress,
    details: `Bloqueo eliminado: ${existing.blocked_date}${existing.blocked_time ? ` ${existing.blocked_time}` : ' (día completo)'}.`,
  });

  return mapBlockedDateRow(existing);
}

async function updateService(db, id, payload, actor, ipAddress = '') {
  const existing = await db.get('SELECT * FROM services WHERE id = ?', [id]);
  if (!existing) {
    throw new AppError('El servicio veterinario indicado no existe.', 404);
  }

  const nextActive =
    payload.active !== undefined ? (payload.active ? 1 : 0) : Number(existing.active);
  const nextDescription =
    payload.description !== undefined ? payload.description : existing.description;
  const nextDuration =
    payload.durationMinutes !== undefined
      ? payload.durationMinutes
      : Number(existing.duration_minutes);

  await db.run(
    `UPDATE services
     SET active = ?, description = ?, duration_minutes = ?
     WHERE id = ?`,
    [nextActive, nextDescription, nextDuration, id]
  );

  await logAuditEvent(db, {
    eventType: 'SERVICE_UPDATED',
    actor,
    ipAddress,
    details: `Servicio "${existing.name}" actualizado (activo=${Boolean(nextActive)}, duración=${nextDuration} min).`,
  });

  const updated = await db.get('SELECT * FROM services WHERE id = ?', [id]);
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
