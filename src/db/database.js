/**
 * @file src/db/database.js
 * @description Inicialización de la base de datos SQLite nativa (`node:sqlite`),
 * ejecución del esquema relacional, siembra idempotente del catálogo inicial
 * (servicios y reglas semanales) y helper de transacciones atómicas `BEGIN IMMEDIATE`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { DEFAULT_SERVICES, DEFAULT_SCHEDULE_RULES } = require('../config/constants');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

/**
 * Inicializa y devuelve una conexión lista para usar a SQLite.
 *
 * - Crea la carpeta contenedora si `dbPath` es un archivo físico.
 * - Habilita llaves foráneas (`PRAGMA foreign_keys = ON`) siempre.
 * - Habilita modo WAL y tiempo de espera para concurrencia en bases físicas.
 * - Aplica `src/db/schema.sql` de forma idempotente (`CREATE TABLE IF NOT EXISTS`).
 * - Inserta los servicios y reglas semanales por defecto solo si aún no existen.
 *
 * @param {string} [dbPath='./data/hospital_fesc.db'] Ruta al archivo SQLite o `':memory:'`.
 * @returns {import('node:sqlite').DatabaseSync} Instancia abierta de SQLite.
 */
function initDatabase(dbPath = './data/hospital_fesc.db') {
  const isMemory = dbPath === ':memory:';

  if (!isMemory) {
    const resolvedPath = path.resolve(dbPath);
    const parentDir = path.dirname(resolvedPath);
    fs.mkdirSync(parentDir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);

  // Garantiza integridad referencial (por ejemplo, citas ligadas a servicios existentes)
  db.exec('PRAGMA foreign_keys = ON;');

  if (!isMemory) {
    // WAL mejora la lectura simultánea mientras se escriben citas o auditoría
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
  }

  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schemaSql);

  seedDefaultData(db);

  return db;
}

/**
 * Siembra los servicios veterinarios y las reglas semanales iniciales de forma
 * idempotente. Usa `INSERT OR IGNORE` para respetar cualquier cambio posterior
 * realizado por el administrador desde el panel.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
function seedDefaultData(db) {
  withTransaction(db, () => {
    const insertService = db.prepare(`
      INSERT OR IGNORE INTO services (name, description, icon, duration_minutes, active)
      VALUES (?, ?, ?, ?, 1)
    `);

    for (const service of DEFAULT_SERVICES) {
      insertService.run(
        service.name,
        service.description,
        service.icon,
        service.duration_minutes
      );
    }

    const insertRule = db.prepare(`
      INSERT OR IGNORE INTO schedule_rules (
        day_of_week, is_open, start_time, end_time, slot_minutes, capacity_per_slot
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const rule of DEFAULT_SCHEDULE_RULES) {
      insertRule.run(
        rule.day_of_week,
        rule.is_open,
        rule.start_time,
        rule.end_time,
        rule.slot_minutes,
        rule.capacity_per_slot
      );
    }
  });
}

/**
 * Ejecuta una función síncrona dentro de una transacción `BEGIN IMMEDIATE`.
 *
 * Usar `BEGIN IMMEDIATE` adquiere el candado de escritura desde el inicio,
 * evitando condiciones de carrera (por ejemplo, dos tutores reservando el
 * último cupo del mismo horario exactamente al mismo instante).
 *
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db Instancia de base de datos.
 * @param {() => T} fn Lógica síncrona a ejecutar atómicamente.
 * @returns {T} Valor devuelto por `fn`.
 */
function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Si SQLite ya revirtió la transacción automáticamente, ignoramos el error de ROLLBACK
    }
    throw err;
  }
}

module.exports = {
  initDatabase,
  withTransaction,
};
