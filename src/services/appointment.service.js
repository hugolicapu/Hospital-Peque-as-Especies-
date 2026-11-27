/**
 * @file src/services/appointment.service.js
 * @description Gestión del ciclo de vida de citas veterinarias:
 * - Creación pública atómica con protección contra doble reserva (`BEGIN IMMEDIATE`).
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
 * Alfabeto sin caracteres ambiguos (se excluyen 0, O, 1, I, L) para que
 * personas mayores o tutores leyendo por teléfono puedan dictar su folio sin errores.
 */
const FOLIO_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/**
 * Genera un folio con el formato `FESC-AAAAMMDD-XXXX` verificando que no exista
 * en la tabla `appointments`.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} dateStr Fecha de la cita en formato `AAAA-MM-DD`.
 * @returns {string}
 */
function generateUniqueFolio(db, dateStr) {
  const compactDate = dateStr.replace(/-/g, '');
  const checkStmt = db.prepare('SELECT id FROM appointments WHERE folio = ?');

  for (let attempt = 0; attempt < 15; attempt += 1) {
    let suffix = '';
    for (let i = 0; i < 4; i += 1) {
      suffix += FOLIO_ALPHABET[crypto.randomInt(0, FOLIO_ALPHABET.length)];
    }
    const candidate = `FESC-${compactDate}-${suffix}`;
    if (!checkStmt.get(candidate)) {
      return candidate;
    }
  }

  throw new AppError(
    'No fue posible generar un folio único para la cita. Intenta nuevamente.',
    500
  );
}

/**
 * Mapea una fila combinada de `appointments` + `services` al formato JSON del API.
 * Oculta `adminNotes` cuando la respuesta se entrega al público.
 *
 * @param {Record<string, any>} row
 * @param {{ includeAdminFields?: boolean }} [options]
 */
function mapAppointmentRow(row, { includeAdminFields = false } = {}) {
  const mapped = {
    id: row.id,
    folio: row.folio,
    serviceId: row.service_id,
    serviceName: row.service_name,
    date: row.appointment_date,
    time: row.appointment_time,
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

/**
 * Registra una cita pública de forma atómica (`BEGIN IMMEDIATE`).
 * Revalida dentro de la transacción que el servicio esté activo, que la fecha
 * sea válida y que el horario aún tenga al menos 1 lugar disponible.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Record<string, any>} payload Datos ya validados por `createAppointmentSchema`.
 */
function createPublicAppointment(db, payload) {
  return withTransaction(db, () => {
    const service = db
      .prepare('SELECT id, name, active FROM services WHERE id = ?')
      .get(payload.serviceId);

    if (!service || !service.active) {
      throw new AppError(
        'El servicio veterinario seleccionado no está disponible actualmente.',
        400
      );
    }

    const availability = getAvailabilityForDate(db, payload.date);
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

    const folio = generateUniqueFolio(db, payload.date);
    const nowIso = new Date().toISOString();
    const normalizedPhone = normalizePhone(payload.ownerPhone);

    const insertInfo = db
      .prepare(`
        INSERT INTO appointments (
          folio, service_id, appointment_date, appointment_time,
          owner_name, owner_phone, owner_email,
          pet_name, pet_species, pet_age, reason_notes,
          status, admin_notes, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', '', ?, ?)
      `)
      .run(
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
        nowIso
      );

    const created = db
      .prepare(`${SELECT_APPOINTMENT_BASE} WHERE a.id = ?`)
      .get(insertInfo.lastInsertRowid);

    return mapAppointmentRow(created, { includeAdminFields: false });
  });
}

/**
 * Busca una cita verificando simultáneamente el folio y el teléfono normalizado.
 * Devuelve el mismo mensaje de error si el folio no existe o el teléfono no coincide
 * para proteger la privacidad de los tutores.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} folio
 * @param {string} phone
 */
function lookupAppointment(db, folio, phone) {
  const cleanFolio = String(folio || '').trim().toUpperCase();
  const cleanPhone = normalizePhone(phone);

  const row = db
    .prepare(`${SELECT_APPOINTMENT_BASE} WHERE UPPER(a.folio) = ?`)
    .get(cleanFolio);

  if (!row || normalizePhone(row.owner_phone) !== cleanPhone) {
    throw new AppError(
      'No encontramos ninguna cita que coincida con ese folio y número de teléfono. Verifica tus datos e intenta nuevamente.',
      404
    );
  }

  return mapAppointmentRow(row, { includeAdminFields: false });
}

/**
 * Cancela una cita pública si coincide folio + teléfono y su estado actual es
 * `pendiente` o `confirmada`, liberando de inmediato ese lugar en la agenda.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} folio
 * @param {string} phone
 * @param {string} [ipAddress='']
 */
function cancelPublicAppointment(db, folio, phone, ipAddress = '') {
  const cleanFolio = String(folio || '').trim().toUpperCase();
  const cleanPhone = normalizePhone(phone);

  return withTransaction(db, () => {
    const row = db
      .prepare(`${SELECT_APPOINTMENT_BASE} WHERE UPPER(a.folio) = ?`)
      .get(cleanFolio);

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
    db.prepare(`
      UPDATE appointments
      SET status = 'cancelada', updated_at = ?
      WHERE id = ?
    `).run(nowIso, row.id);

    logAuditEvent(db, {
      eventType: 'PUBLIC_APPOINTMENT_CANCELLED',
      actor: 'publico',
      ipAddress,
      details: `Cita ${row.folio} cancelada por el tutor (horario ${row.appointment_date} ${row.appointment_time} liberado).`,
    });

    const updated = db
      .prepare(`${SELECT_APPOINTMENT_BASE} WHERE a.id = ?`)
      .get(row.id);

    return mapAppointmentRow(updated, { includeAdminFields: false });
  });
}

/**
 * Obtiene el resumen estadístico y la lista cronológica de citas de un día
 * para el tablero del panel de administrador.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} [dateStr] Fecha `AAAA-MM-DD`; si se omite, utiliza la fecha local de hoy.
 */
function getAdminDashboard(db, dateStr) {
  const targetDate = dateStr && String(dateStr).trim() !== ''
    ? String(dateStr).trim()
    : getTodayDateString();

  if (!isValidDateString(targetDate)) {
    throw new AppError(
      'La fecha solicitada para el tablero no es válida. Usa el formato AAAA-MM-DD.',
      400
    );
  }

  const rows = db
    .prepare(`
      ${SELECT_APPOINTMENT_BASE}
      WHERE a.appointment_date = ?
      ORDER BY a.appointment_time ASC, a.id ASC
    `)
    .all(targetDate);

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

/**
 * Lista citas para el panel de administrador con filtros opcionales por fecha,
 * estado y búsqueda libre (folio, nombre del tutor, teléfono o nombre de mascota).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ date?: string, status?: string, search?: string }} [filters]
 */
function listAdminAppointments(db, { date, status, search } = {}) {
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

  const rows = db
    .prepare(`
      ${SELECT_APPOINTMENT_BASE}
      ${whereClause}
      ORDER BY a.appointment_date DESC, a.appointment_time ASC, a.id DESC
      LIMIT 500
    `)
    .all(...params);

  return rows.map((row) => mapAppointmentRow(row, { includeAdminFields: true }));
}

/**
 * Valida dentro de una transacción que un horario destino tenga cupo real al
 * reprogramar o reactivar una cita desde el panel de administrador, excluyendo
 * la propia cita del conteo de lugares ocupados.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} targetDate
 * @param {string} targetTime
 * @param {number} excludeAppointmentId
 */
function assertSlotCapacityForAdminUpdate(db, targetDate, targetTime, excludeAppointmentId) {
  const dayOfWeek = getDayOfWeek(targetDate);
  const rule = db
    .prepare('SELECT * FROM schedule_rules WHERE day_of_week = ?')
    .get(dayOfWeek);

  if (!rule || !rule.is_open) {
    throw new AppError(
      'No es posible reprogramar a esa fecha porque el hospital está cerrado ese día de la semana.',
      409
    );
  }

  const block = db
    .prepare(`
      SELECT reason FROM blocked_dates
      WHERE blocked_date = ? AND (blocked_time = '' OR blocked_time = ?)
      LIMIT 1
    `)
    .get(targetDate, targetTime);

  if (block) {
    throw new AppError(
      `La fecha u horario seleccionado está bloqueado (${block.reason}).`,
      409
    );
  }

  const validSlots = generateTimeSlots(rule.start_time, rule.end_time, rule.slot_minutes);
  if (!validSlots.includes(targetTime)) {
    throw new AppError(
      'El horario indicado no corresponde a un bloque de atención configurado para ese día.',
      400
    );
  }

  const countRow = db
    .prepare(`
      SELECT COUNT(*) AS booked
      FROM appointments
      WHERE appointment_date = ?
        AND appointment_time = ?
        AND status IN ('pendiente', 'confirmada')
        AND id != ?
    `)
    .get(targetDate, targetTime, excludeAppointmentId);

  if (Number(countRow.booked) >= rule.capacity_per_slot) {
    throw new AppError(
      'El horario seleccionado ya alcanzó su cupo máximo de citas.',
      409
    );
  }
}

/**
 * Actualiza el estado, fecha, horario o notas internas de una cita existente.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @param {{ status?: string, date?: string, time?: string, adminNotes?: string }} updates
 * @param {string} actor
 * @param {string} [ipAddress='']
 */
function updateAdminAppointment(db, id, updates, actor, ipAddress = '') {
  return withTransaction(db, () => {
    const existing = db
      .prepare(`${SELECT_APPOINTMENT_BASE} WHERE a.id = ?`)
      .get(id);

    if (!existing) {
      throw new AppError('La cita indicada no existe.', 404);
    }

    const nextDate = updates.date ?? existing.appointment_date;
    const nextTime = updates.time ?? existing.appointment_time;
    const nextStatus = updates.status ?? existing.status;
    const nextAdminNotes =
      updates.adminNotes !== undefined ? updates.adminNotes : existing.admin_notes;

    const scheduleChanged =
      nextDate !== existing.appointment_date || nextTime !== existing.appointment_time;
    const wasActive =
      existing.status === 'pendiente' || existing.status === 'confirmada';
    const willBeActive =
      nextStatus === 'pendiente' || nextStatus === 'confirmada';

    // Si la cita queda ocupando cupo y cambió de horario o se está reactivando, validar cupo
    if (willBeActive && (scheduleChanged || !wasActive)) {
      assertSlotCapacityForAdminUpdate(db, nextDate, nextTime, existing.id);
    }

    const nowIso = new Date().toISOString();
    db.prepare(`
      UPDATE appointments
      SET
        appointment_date = ?,
        appointment_time = ?,
        status = ?,
        admin_notes = ?,
        updated_at = ?
      WHERE id = ?
    `).run(nextDate, nextTime, nextStatus, nextAdminNotes, nowIso, existing.id);

    const changes = [];
    if (nextStatus !== existing.status) {
      changes.push(`estado: ${existing.status} -> ${nextStatus}`);
    }
    if (scheduleChanged) {
      changes.push(
        `horario: ${existing.appointment_date} ${existing.appointment_time} -> ${nextDate} ${nextTime}`
      );
    }
    if (updates.adminNotes !== undefined && nextAdminNotes !== existing.admin_notes) {
      changes.push('notas internas actualizadas');
    }

    logAuditEvent(db, {
      eventType: 'ADMIN_APPOINTMENT_UPDATED',
      actor,
      ipAddress,
      details: `Cita ${existing.folio} modificada (${changes.join(', ') || 'sin cambios'}).`,
    });

    const updated = db
      .prepare(`${SELECT_APPOINTMENT_BASE} WHERE a.id = ?`)
      .get(existing.id);

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
