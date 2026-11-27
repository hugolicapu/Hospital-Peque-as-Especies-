/**
 * @file src/validators/admin.validator.js
 * @description Esquemas de validación Zod en español para todas las operaciones
 * del administrador único: inicio de sesión, cambio de contraseña fuerte,
 * configuración semanal de horarios, bloqueos de fechas y gestión de servicios.
 */

const { z } = require('zod');
const { SECURITY_CONFIG } = require('../config/constants');
const { isValidDateString, isValidTimeString } = require('./appointment.validator');

/**
 * Convierte `HH:MM` a minutos desde la medianoche para comparar rangos horarios.
 *
 * @param {string} hhmm
 * @returns {number}
 */
function timeToMinutes(hhmm) {
  const [hours, minutes] = hhmm.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Nombre de usuario permitido para la cuenta única de administrador.
 */
const usernameSchema = z
  .string({ required_error: 'El nombre de usuario es obligatorio.' })
  .trim()
  .min(3, 'El nombre de usuario debe tener al menos 3 caracteres.')
  .max(40, 'El nombre de usuario no puede exceder 40 caracteres.')
  .regex(
    /^[a-zA-Z0-9._-]+$/,
    'El usuario solo puede contener letras, números, puntos, guiones y guion bajo.'
  );

/**
 * Política de contraseña fuerte obligatoria para la cuenta de administrador:
 * mínimo 10 caracteres, mayúscula, minúscula, número y símbolo especial.
 */
const strongPasswordSchema = z
  .string({ required_error: 'La contraseña es obligatoria.' })
  .min(
    SECURITY_CONFIG.MIN_PASSWORD_LENGTH,
    `La contraseña debe tener al menos ${SECURITY_CONFIG.MIN_PASSWORD_LENGTH} caracteres.`
  )
  .max(128, 'La contraseña no puede exceder 128 caracteres.')
  .regex(/[A-Z]/, 'La contraseña debe incluir al menos una letra mayúscula.')
  .regex(/[a-z]/, 'La contraseña debe incluir al menos una letra minúscula.')
  .regex(/[0-9]/, 'La contraseña debe incluir al menos un número.')
  .regex(/[^A-Za-z0-9]/, 'La contraseña debe incluir al menos un símbolo especial (ej. !@#$%).');

/**
 * Esquema para iniciar sesión (`POST /api/admin/login`).
 */
const loginSchema = z.object({
  username: z
    .string({ required_error: 'Ingresa tu usuario.' })
    .trim()
    .min(1, 'Ingresa tu usuario.')
    .max(64, 'El usuario es demasiado largo.'),
  password: z
    .string({ required_error: 'Ingresa tu contraseña.' })
    .min(1, 'Ingresa tu contraseña.')
    .max(128, 'La contraseña es demasiado larga.'),
});

/**
 * Esquema para cambiar la contraseña del administrador (`POST /api/admin/change-password`).
 */
const changePasswordSchema = z
  .object({
    currentPassword: z
      .string({ required_error: 'Ingresa tu contraseña actual.' })
      .min(1, 'Ingresa tu contraseña actual.')
      .max(128, 'La contraseña actual es demasiado larga.'),
    newPassword: strongPasswordSchema,
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    path: ['newPassword'],
    message: 'La nueva contraseña debe ser diferente a la contraseña actual.',
  });

/**
 * Permite aceptar booleanos nativos (`true`/`false`) o valores SQLite (`1`/`0`).
 */
const flexibleBooleanSchema = z.preprocess((val) => {
  if (val === 1 || val === '1' || val === 'true') return true;
  if (val === 0 || val === '0' || val === 'false') return false;
  return val;
}, z.boolean({ invalid_type_error: 'Debe indicarse un valor verdadero o falso.' }));

/**
 * Regla individual de horario para un día de la semana (0 = Domingo ... 6 = Sábado).
 */
const scheduleRuleItemSchema = z
  .object({
    dayOfWeek: z.coerce
      .number()
      .int('El día de la semana debe ser un entero entre 0 y 6.')
      .min(0, 'El día de la semana debe estar entre 0 (Domingo) y 6 (Sábado).')
      .max(6, 'El día de la semana debe estar entre 0 (Domingo) y 6 (Sábado).'),
    isOpen: flexibleBooleanSchema,
    startTime: z
      .string({ required_error: 'La hora de inicio es obligatoria.' })
      .trim()
      .refine(isValidTimeString, 'La hora de inicio debe tener formato HH:MM.'),
    endTime: z
      .string({ required_error: 'La hora de cierre es obligatoria.' })
      .trim()
      .refine(isValidTimeString, 'La hora de cierre debe tener formato HH:MM.'),
    slotMinutes: z.coerce
      .number()
      .int()
      .refine(
        (val) => [15, 20, 30, 45, 60].includes(val),
        'La duración de cada cita debe ser 15, 20, 30, 45 o 60 minutos.'
      ),
    capacityPerSlot: z.coerce
      .number()
      .int('El cupo por horario debe ser un número entero.')
      .min(1, 'El cupo por horario debe ser mínimo 1.')
      .max(20, 'El cupo por horario no puede exceder 20 citas simultáneas.'),
  })
  .refine(
    (rule) => timeToMinutes(rule.startTime) < timeToMinutes(rule.endTime),
    {
      path: ['endTime'],
      message: 'La hora de cierre debe ser posterior a la hora de inicio.',
    }
  )
  .refine(
    (rule) =>
      !rule.isOpen ||
      timeToMinutes(rule.endTime) - timeToMinutes(rule.startTime) >= rule.slotMinutes,
    {
      path: ['slotMinutes'],
      message: 'El rango horario abierto debe permitir al menos un bloque de atención.',
    }
  );

/**
 * Esquema para actualizar las 7 reglas semanales (`PUT /api/admin/schedule/rules`).
 */
const scheduleRulesSchema = z.object({
  rules: z
    .array(scheduleRuleItemSchema, {
      required_error: 'Debes enviar las reglas de los 7 días de la semana.',
    })
    .length(7, 'Deben enviarse exactamente las reglas de los 7 días (domingo a sábado).')
    .refine(
      (rules) => new Set(rules.map((r) => r.dayOfWeek)).size === 7,
      'No puede haber días de la semana duplicados en la configuración.'
    ),
});

/**
 * Esquema para crear un bloqueo de fecha completa o de una franja específica
 * (`POST /api/admin/schedule/blocks`).
 */
const blockDateSchema = z.object({
  blockedDate: z
    .string({ required_error: 'La fecha a bloquear es obligatoria.' })
    .trim()
    .refine(isValidDateString, 'La fecha a bloquear debe tener formato AAAA-MM-DD.'),
  blockedTime: z
    .string()
    .trim()
    .refine(
      (val) => val === '' || isValidTimeString(val),
      'La hora bloqueada debe tener formato HH:MM o quedar vacía para bloquear todo el día.'
    )
    .optional()
    .default(''),
  reason: z
    .string({ required_error: 'Indica el motivo del bloqueo.' })
    .trim()
    .min(3, 'El motivo del bloqueo debe tener al menos 3 caracteres.')
    .max(200, 'El motivo del bloqueo no puede exceder 200 caracteres.'),
});

/**
 * Esquema para actualizar un servicio veterinario (`PATCH /api/admin/services/:id`).
 */
const updateServiceSchema = z
  .object({
    active: flexibleBooleanSchema.optional(),
    description: z
      .string()
      .trim()
      .min(5, 'La descripción del servicio debe tener al menos 5 caracteres.')
      .max(300, 'La descripción no puede exceder 300 caracteres.')
      .optional(),
    durationMinutes: z.coerce
      .number()
      .int('La duración debe ser un número entero en minutos.')
      .min(10, 'La duración mínima de un servicio es de 10 minutos.')
      .max(180, 'La duración máxima de un servicio es de 180 minutos.')
      .optional(),
  })
  .refine(
    (data) =>
      data.active !== undefined ||
      data.description !== undefined ||
      data.durationMinutes !== undefined,
    {
      message: 'Debes indicar al menos un campo para actualizar el servicio.',
    }
  );

module.exports = {
  usernameSchema,
  strongPasswordSchema,
  loginSchema,
  changePasswordSchema,
  scheduleRulesSchema,
  blockDateSchema,
  updateServiceSchema,
};
