/**
 * @file src/validators/appointment.validator.js
 * @description Esquemas de validación Zod y utilidades de normalización para
 * el flujo de citas públicas (creación, consulta, cancelación) y su gestión
 * desde el panel de administrador. Todos los mensajes están en español claro.
 */

const { z } = require('zod');
const { PET_SPECIES, APPOINTMENT_STATUSES } = require('../config/constants');

/**
 * Extrae únicamente los dígitos de un número telefónico.
 * Permite que los usuarios capturen espacios, guiones o paréntesis
 * (por ejemplo "55 1234-5678") sin provocar rechazos innecesarios.
 *
 * @param {unknown} rawPhone
 * @returns {string} Cadena compuesta únicamente por dígitos.
 */
function normalizePhone(rawPhone) {
  return String(rawPhone ?? '').replace(/\D/g, '');
}

/**
 * Verifica que una cadena tenga formato `AAAA-MM-DD` y corresponda a una
 * fecha real del calendario (rechaza fechas inexistentes como `2026-02-30`).
 *
 * @param {string} value
 * @returns {boolean}
 */
function isValidDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Verifica que una cadena represente una hora válida en formato 24h `HH:MM`.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isValidTimeString(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/**
 * Esquema reutilizable de teléfono: normaliza a dígitos y exige entre 8 y 15
 * dígitos (compatible con teléfonos mexicanos de 10 dígitos y números con lada).
 */
const phoneSchema = z
  .string({ required_error: 'El teléfono de contacto es obligatorio.' })
  .trim()
  .transform(normalizePhone)
  .refine(
    (digits) => digits.length >= 8 && digits.length <= 15,
    'Ingresa un teléfono válido de 10 dígitos (entre 8 y 15 dígitos numéricos).'
  );

const dateFieldSchema = z
  .string({ required_error: 'La fecha de la cita es obligatoria.' })
  .trim()
  .refine(
    isValidDateString,
    'La fecha debe tener un formato válido (AAAA-MM-DD).'
  );

const timeFieldSchema = z
  .string({ required_error: 'El horario de la cita es obligatorio.' })
  .trim()
  .refine(
    isValidTimeString,
    'El horario debe tener un formato válido de 24 horas (HH:MM).'
  );

/**
 * Esquema para crear una nueva cita desde el portal público (`POST /api/public/appointments`).
 */
const createAppointmentSchema = z.object({
  serviceId: z.coerce
    .number({ invalid_type_error: 'Selecciona un servicio veterinario válido.' })
    .int('Selecciona un servicio veterinario válido.')
    .positive('Selecciona un servicio veterinario válido.'),
  date: dateFieldSchema,
  time: timeFieldSchema,
  ownerName: z
    .string({ required_error: 'El nombre del tutor es obligatorio.' })
    .trim()
    .min(3, 'Escribe tu nombre completo (mínimo 3 caracteres).')
    .max(120, 'El nombre del tutor no puede exceder 120 caracteres.'),
  ownerPhone: phoneSchema,
  ownerEmail: z
    .string()
    .trim()
    .max(120, 'El correo electrónico es demasiado largo.')
    .refine(
      (val) => val === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val),
      'Ingresa un correo electrónico válido o déjalo vacío.'
    )
    .optional()
    .default(''),
  petName: z
    .string({ required_error: 'El nombre de tu mascota es obligatorio.' })
    .trim()
    .min(1, 'Escribe el nombre de tu mascota.')
    .max(80, 'El nombre de la mascota no puede exceder 80 caracteres.'),
  petSpecies: z.enum(PET_SPECIES, {
    errorMap: () => ({ message: 'Selecciona una especie atendida por el hospital.' }),
  }),
  petAge: z
    .string()
    .trim()
    .max(40, 'La edad de la mascota no puede exceder 40 caracteres.')
    .optional()
    .default(''),
  reasonNotes: z
    .string()
    .trim()
    .max(500, 'El motivo de consulta no puede exceder 500 caracteres.')
    .optional()
    .default(''),
});

/**
 * Esquema para consultar o cancelar una cita pública mediante folio y teléfono.
 */
const lookupAppointmentSchema = z.object({
  folio: z
    .string({ required_error: 'El folio de la cita es obligatorio.' })
    .trim()
    .transform((val) => val.toUpperCase())
    .refine(
      (val) => /^FESC-\d{8}-[A-Z0-9]{4,8}$/.test(val),
      'El folio debe tener el formato FESC-AAAAMMDD-XXXX (ejemplo: FESC-20260515-A7K2).'
    ),
  phone: phoneSchema,
});

/**
 * Esquema para actualizar una cita desde el panel de administrador (`PATCH /api/admin/appointments/:id`).
 */
const updateAppointmentSchema = z
  .object({
    status: z
      .enum(APPOINTMENT_STATUSES, {
        errorMap: () => ({
          message: 'El estado debe ser: pendiente, confirmada, atendida o cancelada.',
        }),
      })
      .optional(),
    date: dateFieldSchema.optional(),
    time: timeFieldSchema.optional(),
    adminNotes: z
      .string()
      .trim()
      .max(1000, 'Las notas internas no pueden exceder 1000 caracteres.')
      .optional(),
  })
  .refine(
    (data) =>
      data.status !== undefined ||
      data.date !== undefined ||
      data.time !== undefined ||
      data.adminNotes !== undefined,
    {
      message: 'Debes indicar al menos un campo para actualizar la cita.',
    }
  );

module.exports = {
  normalizePhone,
  isValidDateString,
  isValidTimeString,
  phoneSchema,
  createAppointmentSchema,
  lookupAppointmentSchema,
  updateAppointmentSchema,
};
