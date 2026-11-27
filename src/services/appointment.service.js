/**
 * @file src/services/appointment.service.js
 * @description Gestión del ciclo de vida de citas veterinarias:
 * - Creación pública atómica con protección contra doble reserva.
 * - Generación de folios únicos legibles `FESC-AAAAMMDD-XXXX` sin caracteres confusos.
 * - Consulta y cancelación pública verificando coincidencia de folio + teléfono.
 * - Tablero diario, búsqueda filtrada y edición/reprogramación para el administrador.
 */

const crypto = require('node:crypto');
const { APPOINTMENT_STATUSES } = require('../config/constants');
const { withTransaction } = require('../db/database');
const { AppError } = require('../middleware/error.middleware');
const {
  normalizePhone,
  isValidDateString,
} = require('../validators/appointment.validator');
const {
  getTodayDateString,
  getDayOfWeek,
  generateTimeSlots,
  getAvailabilityForDate,
} = require('./schedule.service');
const { logAuditEvent } = require('./audit.service');

/**
 * Alfabeto sin caracteres ambiguos (sin 0, O, 1, I, L) para facilitar lectura en voz alta.
 */
const FOLIO_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

async function generateUniqueFolio(db, dateStr) {
  const compactDate = dateStr.replace(/-/g, '');

  for (let attempt = 0; attempt < 15; attempt += 1) {
    let suffix = '';
    for (let i = 0; i < 4; i += 1) {
      suffix += FOLIO_ALPHABET[crypto.randomInt(0, FOLIO_ALPHABET.length)];
    }
    const candidate = `FESC-${compactDate}-${suffix}`;
    const existing = await db.get('SELECT id FROM appointments WHERE folio = ?', [candidate]);
    if (!existing) {
      return candidate;
    }
  }

  throw new AppError(
    'No fue posible generar un folio único para la cita. Intenta nuevamente.',
    500
  );
}

function mapAppointmentRow(row, { includeAdminFields = false } = {}) {
  const mapped = {
    id: Number(row.id),
    folio: row.folio,
    serviceId: Number(row.service_id),
    serviceName: row.service_name,
    date: row.appointment_date,
    time: String(row.appointment_time).slice(0, 5),
    ownerName: row.owner_name,
    ownerPhone: row.owner_phone,
    ownerEmail: row.owner_email || '',
    petName: row.pet_name,
    petSpecies: row.pet_species,
    petAge: row.pet_age || '',
    reasonNotes: row.reason_notes || '',
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (includeAdminFields) {
    mapped.adminNotes = row.admin_notes || '';
  }

  return mapped;
}

const SELECT_APPOINTMENT_BASE = `
  SELECT
    a.id,
    a.folio,
    a.service_id,
    s.name AS service_name,
    a.appointment_date,
    a.appointment_time,
    a.owner_name,
    a.owner_phone,
    a.owner_email,
    a.pet_name,
    a.pet_species,
    a.pet_age,
    a.reason_notes,
    a.status,
    a.admin_notes,
    a.created_at,
    a.updated_at
  FROM appointments a
  INNER JOIN services s ON s.id = a.service_id
`;

async function createPublicAppointment(db, payload) {
  return withTransaction(db, async (tx) => {
    const service = await tx.get(
      'SELECT id, name, active FROM services WHERE id = ?',
      [payload.serviceId]
    );

    if (!service || !service.active) {
      throw new AppError(
        'El servicio veterinario seleccionado no está disponible actualmente.',
        400
      );
    }

    const availability = await getAvailabilityForDate(tx, payload.date);
    if (!availability.isOpen || availability.dayBlocked) {
      throw new AppError(
        availability.blockReason || 'La fecha seleccionada no tiene atención disponible.',
        409
      );
    }

    const targetSlot = availability.slots.find((slot) => slot.time === payload.time);
    if (!targetSlot) {
      throw new AppError(
        'El horario seleccionado no corresponde a un bloque de atención válido para esa fecha.',
        400
      );
    }

    if (!targetSlot.isAvailable) {
      const detail = targetSlot.reason ? ` (${targetSlot.reason})` : '';
      throw new AppError(
        `El horario seleccionado ya no está disponible${detail}. Por favor elige otro horario.`,
        409
      );
    }

    const folio = await generateUniqueFolio(tx, payload.date);
    const nowIso = new Date().toISOString();
    const normalizedPhone = normalizePhone(payload.ownerPhone);

    const insertInfo = await tx.run(
      `INSERT INTO appointments (
        folio, service_id, appointment_date, appointment_time,
        owner_name, owner_phone, owner_email,
        pet_name, pet_species, pet_age, reason_notes,
        status, admin_notes, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', '', ?, ?)`,
      [
        folio,
        service.id,
        payload.date,
        payload.time,
        payload.ownerName,
        normalizedPhone,
        payload.ownerEmail || '',
        payload.petName,
        payload.petSpecies,
        payload.petAge || '',
        payload.reasonNotes || '',
        nowIso,
        nowIso,
      ]
    );

    const created = await tx.get(
      `${SELECT_APPOINTMENT_BASE} WHERE a.id = ?`,
      [insertInfo.lastInsertRowid]
    );

    return mapAppointmentRow(created, { includeAdminFields: false });
  });
}

async function lookupAppointment(db, folio, phone) {
  const cleanFolio = String(folio || '').trim().toUpperCase();
  const cleanPhone = normalizePhone(phone);

  const row = await db.get(
    `${SELECT_APPOINTMENT_BASE} WHERE UPPER(a.folio) = ?`,
    [cleanFolio]
  );

  if (!row || normalizePhone(row.owner_phone) !== cleanPhone) {
    throw new AppError(
      'No encontramos ninguna cita que coincida con ese folio y número de teléfono. Verifica tus datos e intenta nuevamente.',
      404
    );
  }

  return mapAppointmentRow(row, { includeAdminFields: false });
}

async function cancelPublicAppointment(db, folio, phone, ipAddress = '') {
  const cleanFolio = String(folio || '').trim().toUpperCase();
  const cleanPhone = normalizePhone(phone);

  return withTransaction(db, async (tx) => {
    const row = await tx.get(
      `${SELECT_APPOINTMENT_BASE} WHERE UPPER(a.folio) = ?`,
      [cleanFolio]
    );

    if (!row || normalizePhone(row.owner_phone) !== cleanPhone) {
      throw new AppError(
        'No encontramos ninguna cita que coincida con ese folio y número de teléfono.',
        404
      );
    }

    if (row.status === 'cancelada') {
      throw new AppError('Esta cita ya se encontraba cancelada.', 409);
    }

    if (row.status === 'atendida') {
      throw new AppError(
        'No es posible cancelar una cita que ya fue marcada como atendida.',
        409
      );
    }

    const nowIso = new Date().toISOString();
    await tx.run(
      `UPDATE appointments
       SET status = 'cancelada', updated_at = ?
       WHERE id = ?`,
      [nowIso, row.id]
    );

    await logAuditEvent(tx, {
      eventType: 'PUBLIC_APPOINTMENT_CANCELLED',
      actor: 'publico',
      ipAddress,
      details: `Cita ${row.folio} cancelada por el tutor (horario ${row.appointment_date} ${row.appointment_time} liberado).`,
    });

    const updated = await tx.get(`${SELECT_APPOINTMENT_BASE} WHERE a.id = ?`, [row.id]);
    return mapAppointmentRow(updated, { includeAdminFields: false });
  });
}

async function getAdminDashboard(db, dateStr) {
  const targetDate =
    dateStr && String(dateStr).trim() !== ''
      ? String(dateStr).trim()
      : getTodayDateString();

  if (!isValidDateString(targetDate)) {
    throw new AppError(
      'La fecha solicitada para el tablero no es válida. Usa el formato AAAA-MM-DD.',
      400
    );
  }

  const rows = await db.all(
    `${SELECT_APPOINTMENT_BASE}
     WHERE a.appointment_date = ?
     ORDER BY a.appointment_time ASC, a.id ASC`,
    [targetDate]
  );

  const stats = {
    total: rows.length,
    pendiente: 0,
    confirmada: 0,
    atendida: 0,
    cancelada: 0,
  };

  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(stats, row.status)) {
      stats[row.status] += 1;
    }
  }

  return {
    date: targetDate,
    stats,
    appointments: rows.map((row) =>
      mapAppointmentRow(row, { includeAdminFields: true })
    ),
  };
}

async function listAdminAppointments(db, { date, status, search } = {}) {
  const conditions = [];
  const params = [];

  if (date && String(date).trim() !== '') {
    const cleanDate = String(date).trim();
    if (!isValidDateString(cleanDate)) {
      throw new AppError('El filtro de fecha debe tener formato AAAA-MM-DD.', 400);
    }
    conditions.push('a.appointment_date = ?');
    params.push(cleanDate);
  }

  if (status && String(status).trim() !== '') {
    const cleanStatus = String(status).trim();
    if (!APPOINTMENT_STATUSES.includes(cleanStatus)) {
      throw new AppError(
        'El filtro de estado debe ser pendiente, confirmada, atendida o cancelada.',
        400
      );
    }
    conditions.push('a.status = ?');
    params.push(cleanStatus);
  }

  if (search && String(search).trim() !== '') {
    const term = `%${String(search).trim()}%`;
    conditions.push(
      '(a.folio LIKE ? OR a.owner_name LIKE ? OR a.owner_phone LIKE ? OR a.pet_name LIKE ?)'
    );
    params.push(term, term, term, term);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await db.all(
    `${SELECT_APPOINTMENT_BASE}
     ${whereClause}
     ORDER BY a.appointment_date DESC, a.appointment_time ASC, a.id DESC
     LIMIT 500`,
    params
  );

  return rows.map((row) => mapAppointmentRow(row, { includeAdminFields: true }));
}

async function assertSlotCapacityForAdminUpdate(db, targetDate, targetTime, excludeAppointmentId) {
  const dayOfWeek = getDayOfWeek(targetDate);
  const rule = await db.get('SELECT * FROM schedule_rules WHERE day_of_week = ?', [dayOfWeek]);

  if (!rule || !rule.is_open) {
    throw new AppError(
      'No es posible reprogramar a esa fecha porque el hospital está cerrado ese día de la semana.',
      409
    );
  }

  const block = await db.get(
    `SELECT reason FROM blocked_dates
     WHERE blocked_date = ? AND (blocked_time = '' OR blocked_time = ?)
     LIMIT 1`,
    [targetDate, targetTime]
  );

  if (block) {
    throw new AppError(
      `La fecha u horario seleccionado está bloqueado (${block.reason}).`,
      409
    );
  }

  const validSlots = generateTimeSlots(
    String(rule.start_time).slice(0, 5),
    String(rule.end_time).slice(0, 5),
    Number(rule.slot_minutes)
  );
  if (!validSlots.includes(targetTime)) {
    throw new AppError(
      'El horario indicado no corresponde a un bloque de atención configurado para ese día.',
      400
    );
  }

  const countRow = await db.get(
    `SELECT COUNT(*) AS booked
     FROM appointments
     WHERE appointment_date = ?
       AND appointment_time = ?
       AND status IN ('pendiente', 'confirmada')
       AND id != ?`,
    [targetDate, targetTime, excludeAppointmentId]
  );

  if (Number(countRow.booked) >= Number(rule.capacity_per_slot)) {
    throw new AppError(
      'El horario seleccionado ya alcanzó su cupo máximo de citas.',
      409
    );
  }
}

async function updateAdminAppointment(db, id, updates, actor, ipAddress = '') {
  return withTransaction(db, async (tx) => {
    const existing = await tx.get(`${SELECT_APPOINTMENT_BASE} WHERE a.id = ?`, [id]);

    if (!existing) {
      throw new AppError('La cita indicada no existe.', 404);
    }

    const existingTime = String(existing.appointment_time).slice(0, 5);
    const nextDate = updates.date ?? existing.appointment_date;
    const nextTime = updates.time ?? existingTime;
    const nextStatus = updates.status ?? existing.status;
    const nextAdminNotes =
      updates.adminNotes !== undefined ? updates.adminNotes : existing.admin_notes;

    const scheduleChanged =
      nextDate !== existing.appointment_date || nextTime !== existingTime;
    const wasActive =
      existing.status === 'pendiente' || existing.status === 'confirmada';
    const willBeActive =
      nextStatus === 'pendiente' || nextStatus === 'confirmada';

    if (willBeActive && (scheduleChanged || !wasActive)) {
      await assertSlotCapacityForAdminUpdate(tx, nextDate, nextTime, existing.id);
    }

    const nowIso = new Date().toISOString();
    await tx.run(
      `UPDATE appointments
       SET
         appointment_date = ?,
         appointment_time = ?,
         status = ?,
         admin_notes = ?,
         updated_at = ?
       WHERE id = ?`,
      [nextDate, nextTime, nextStatus, nextAdminNotes, nowIso, existing.id]
    );

    const changes = [];
    if (nextStatus !== existing.status) {
      changes.push(`estado: ${existing.status} -> ${nextStatus}`);
    }
    if (scheduleChanged) {
      changes.push(
        `horario: ${existing.appointment_date} ${existingTime} -> ${nextDate} ${nextTime}`
      );
    }
    if (updates.adminNotes !== undefined && nextAdminNotes !== existing.admin_notes) {
      changes.push('notas internas actualizadas');
    }

    await logAuditEvent(tx, {
      eventType: 'ADMIN_APPOINTMENT_UPDATED',
      actor,
      ipAddress,
      details: `Cita ${existing.folio} modificada (${changes.join(', ') || 'sin cambios'}).`,
    });

    const updated = await tx.get(`${SELECT_APPOINTMENT_BASE} WHERE a.id = ?`, [existing.id]);
    return mapAppointmentRow(updated, { includeAdminFields: true });
  });
}

module.exports = {
  generateUniqueFolio,
  createPublicAppointment,
  lookupAppointment,
  cancelPublicAppointment,
  getAdminDashboard,
  listAdminAppointments,
  updateAdminAppointment,
};
