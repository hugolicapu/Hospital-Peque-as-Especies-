/**
 * @file src/config/constants.js
 * @description Constantes institucionales del Hospital de Pequeñas Especies
 * de la UNAM FES Cuautitlán (Campo 4) y parámetros de seguridad por defecto.
 *
 * Centralizar estos valores aquí permite que cualquier desarrollador cambie
 * datos de contacto, especies permitidas o límites de seguridad sin buscar
 * valores repartidos por todo el código.
 */

const HOSPITAL_INFO = Object.freeze({
  name: 'Hospital de Pequeñas Especies',
  institution: 'UNAM · FES Cuautitlán (Campo 4)',
  address: 'Av. Jorge Jiménez Gallardo S/N, Col. San Sebastián Xhala, Cuautitlán Izcalli, Edo. de Méx., C.P. 54714 (Campo 4, a un costado del Hospital de Equinos)',
  phone: '55 5623 1999 (Ext. 39481 y 39484)',
  phoneDial: '5556231999',
  email: 'hpe@cuautitlan.unam.mx',
  arrivalMinutes: 15,
  maxDaysAhead: 30,
});

/**
 * Especies atendidas en el Hospital de Pequeñas Especies.
 * Se usan tanto en la validación del backend (Zod) como en la interfaz pública.
 */
const PET_SPECIES = Object.freeze([
  'Perro',
  'Gato',
  'Ave',
  'Conejo / Roedor',
  'Reptil',
  'Otra pequeña especie',
]);

/**
 * Estados válidos en el ciclo de vida de una cita médica veterinaria.
 */
const APPOINTMENT_STATUSES = Object.freeze([
  'pendiente',
  'confirmada',
  'atendida',
  'cancelada',
]);

/**
 * Catálogo inicial de servicios que se inserta la primera vez que arranca
 * la base de datos. El administrador puede activar/desactivar servicios luego.
 */
const DEFAULT_SERVICES = Object.freeze([
  {
    name: 'Consulta general',
    description: 'Revisión médica completa para síntomas nuevos, chequeo anual o malestar general.',
    icon: 'bi-heart-pulse-fill',
    duration_minutes: 30,
  },
  {
    name: 'Vacunación',
    description: 'Aplicación de vacunas preventivas y actualización de cartilla de salud.',
    icon: 'bi-shield-plus',
    duration_minutes: 30,
  },
  {
    name: 'Desparasitación',
    description: 'Control de parásitos internos y externos acorde al peso y especie.',
    icon: 'bi-capsule-pill',
    duration_minutes: 30,
  },
  {
    name: 'Revisión y seguimiento',
    description: 'Control posterior a tratamiento, curaciones o retiro de puntos.',
    icon: 'bi-clipboard2-check-fill',
    duration_minutes: 30,
  },
  {
    name: 'Consulta de especialidad',
    description: 'Valoración especializada (dermatología, oftalmología, ortopedia o cardiología).',
    icon: 'bi-hospital-fill',
    duration_minutes: 30,
  },
]);

/**
 * Reglas de horario semanal iniciales (0 = Domingo, 1 = Lunes ... 6 = Sábado).
 * Horario oficial del Hospital de Pequeñas Especies UNAM FES Cuautitlán (Campo 4):
 * lunes a viernes de 10:00 a 18:00 con bloques de 30 minutos y 2 citas por bloque.
 * Sábados y domingos permanece cerrado.
 */
const DEFAULT_SCHEDULE_RULES = Object.freeze([
  { day_of_week: 0, is_open: 0, start_time: '10:00', end_time: '14:00', slot_minutes: 30, capacity_per_slot: 2 },
  { day_of_week: 1, is_open: 1, start_time: '10:00', end_time: '18:00', slot_minutes: 30, capacity_per_slot: 2 },
  { day_of_week: 2, is_open: 1, start_time: '10:00', end_time: '18:00', slot_minutes: 30, capacity_per_slot: 2 },
  { day_of_week: 3, is_open: 1, start_time: '10:00', end_time: '18:00', slot_minutes: 30, capacity_per_slot: 2 },
  { day_of_week: 4, is_open: 1, start_time: '10:00', end_time: '18:00', slot_minutes: 30, capacity_per_slot: 2 },
  { day_of_week: 5, is_open: 1, start_time: '10:00', end_time: '18:00', slot_minutes: 30, capacity_per_slot: 2 },
  { day_of_week: 6, is_open: 0, start_time: '10:00', end_time: '14:00', slot_minutes: 30, capacity_per_slot: 2 },
]);

/**
 * Parámetros de seguridad del panel de administrador único.
 */
const SECURITY_CONFIG = Object.freeze({
  BCRYPT_ROUNDS: 12,
  MAX_FAILED_LOGIN_ATTEMPTS: 5,
  LOCKOUT_MINUTES: 15,
  DEFAULT_SESSION_TIMEOUT_MINUTES: 15,
  MIN_PASSWORD_LENGTH: 10,
});

module.exports = {
  HOSPITAL_INFO,
  PET_SPECIES,
  APPOINTMENT_STATUSES,
  DEFAULT_SERVICES,
  DEFAULT_SCHEDULE_RULES,
  SECURITY_CONFIG,
};
