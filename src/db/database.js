/**
 * @file src/db/database.js
 * @description Adaptador unificado y asíncrono de base de datos para el Hospital
 * de Pequeñas Especies UNAM FES Cuautitlán (Campo 4).
 *
 * Soporta dos motores mediante la misma interfaz (`get`, `all`, `run`, `withTransaction`, `close`):
 * 1. **MySQL / MariaDB (XAMPP)** (`DB_CLIENT=mysql`, valor por defecto):
 *    Conecta con `mysql2/promise` al servidor MariaDB de XAMPP (`127.0.0.1:3306`),
 *    crea automáticamente la base de datos `hospital_fesc_citas` si no existe,
 *    aplica `src/db/schema.mysql.sql` y siembra datos iniciales de forma idempotente.
 * 2. **SQLite nativo de Node 22** (`DB_CLIENT=sqlite` o `dbPath: ':memory:'`):
 *    Ideal para pruebas automatizadas ultrarrápidas en memoria o despliegues sin XAMPP.
 *
 * Todas las consultas utilizan sentencias parametrizadas (`?`) para prevenir SQL Injection.
 */

const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { DatabaseSync } = require('node:sqlite');
const { DEFAULT_SERVICES, DEFAULT_SCHEDULE_RULES } = require('../config/constants');

const SQLITE_SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const MYSQL_SCHEMA_PATH = path.join(__dirname, 'schema.mysql.sql');

/**
 * Divide un archivo SQL en sentencias individuales limpiando comentarios `--`.
 * Permite ejecutar el esquema sin activar `multipleStatements` en el pool principal.
 *
 * @param {string} sqlContent
 * @returns {string[]}
 */
function splitSqlStatements(sqlContent) {
  return sqlContent
    .split('\n')
    .map((line) => (line.trim().startsWith('--') ? '' : line))
    .join('\n')
    .split(';')
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
}

/**
 * Envuelve una conexión o pool de `mysql2/promise` en la interfaz uniforme del proyecto.
 *
 * @param {import('mysql2/promise').Pool | import('mysql2/promise').PoolConnection} executor
 * @param {import('mysql2/promise').Pool} [poolForTx]
 */
function wrapMysqlExecutor(executor, poolForTx = null) {
  const adapter = {
    dialect: 'mysql',

    async get(sql, params = []) {
      const [rows] = await executor.execute(sql, params);
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    },

    async all(sql, params = []) {
      const [rows] = await executor.execute(sql, params);
      return Array.isArray(rows) ? rows : [];
    },

    async run(sql, params = []) {
      const [result] = await executor.execute(sql, params);
      return {
        lastInsertRowid: Number(result?.insertId || 0),
        changes: Number(result?.affectedRows || 0),
      };
    },

    async withTransaction(fn) {
      if (!poolForTx) {
        // Ya estamos dentro de una transacción activa sobre esta conexión dedicada
        return fn(adapter);
      }

      const conn = await poolForTx.getConnection();
      const txAdapter = wrapMysqlExecutor(conn, null);
      try {
        await conn.beginTransaction();
        const result = await fn(txAdapter);
        await conn.commit();
        return result;
      } catch (err) {
        try {
          await conn.rollback();
        } catch {
          // Ignorar errores secundarios si la conexión ya se cerró
        }
        throw err;
      } finally {
        conn.release();
      }
    },

    async close() {
      if (poolForTx) {
        await poolForTx.end();
      }
    },
  };

  return adapter;
}

/**
 * Envuelve una instancia `DatabaseSync` de `node:sqlite` con la misma interfaz asíncrona.
 *
 * @param {import('node:sqlite').DatabaseSync} rawDb
 */
function wrapSqliteDatabase(rawDb) {
  let inTransaction = false;

  const adapter = {
    dialect: 'sqlite',

    async get(sql, params = []) {
      const row = rawDb.prepare(sql).get(...params);
      return row === undefined ? null : row;
    },

    async all(sql, params = []) {
      return rawDb.prepare(sql).all(...params);
    },

    async run(sql, params = []) {
      const info = rawDb.prepare(sql).run(...params);
      return {
        lastInsertRowid: Number(info?.lastInsertRowid || 0),
        changes: Number(info?.changes || 0),
      };
    },

    async withTransaction(fn) {
      if (inTransaction) {
        return fn(adapter);
      }

      rawDb.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      try {
        const result = await fn(adapter);
        rawDb.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          rawDb.exec('ROLLBACK');
        } catch {
          // Ignorar si SQLite ya revirtió la transacción
        }
        throw err;
      } finally {
        inTransaction = false;
      }
    },

    async close() {
      rawDb.close();
    },
  };

  return adapter;
}

/**
 * Inserta servicios y reglas de horario iniciales si aún no existen (operación idempotente).
 *
 * @param {{ dialect: 'mysql' | 'sqlite', run: Function, withTransaction: Function }} db
 */
async function seedInitialData(db) {
  const insertKeyword = db.dialect === 'mysql' ? 'INSERT IGNORE INTO' : 'INSERT OR IGNORE INTO';

  await db.withTransaction(async (tx) => {
    for (const service of DEFAULT_SERVICES) {
      await tx.run(
        `${insertKeyword} services (name, description, icon, duration_minutes, active)
         VALUES (?, ?, ?, ?, 1)`,
        [service.name, service.description, service.icon, service.duration_minutes]
      );
    }

    for (const rule of DEFAULT_SCHEDULE_RULES) {
      await tx.run(
        `${insertKeyword} schedule_rules (
          day_of_week, is_open, start_time, end_time, slot_minutes, capacity_per_slot
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          rule.day_of_week,
          rule.is_open,
          rule.start_time,
          rule.end_time,
          rule.slot_minutes,
          rule.capacity_per_slot,
        ]
      );
    }
  });
}

/**
 * Inicializa conexión con MySQL / MariaDB (XAMPP), crea la base de datos y tablas si faltan.
 *
 * @param {object} cfg
 */
async function initMysqlDatabase(cfg) {
  const host = cfg.host || process.env.DB_HOST || '127.0.0.1';
  const port = Number.parseInt(String(cfg.port || process.env.DB_PORT || '3306'), 10);
  const user = cfg.user || process.env.DB_USER || 'root';
  const password =
    cfg.password !== undefined ? cfg.password : (process.env.DB_PASSWORD ?? '');
  const database = cfg.database || process.env.DB_NAME || 'hospital_fesc_citas';

  // Validar nombre de base de datos para interpolarlo seguro en CREATE DATABASE
  if (!/^[a-zA-Z0-9_]+$/.test(database)) {
    throw new Error(`Nombre de base de datos MySQL inválido: "${database}".`);
  }

  // 1. Conexión inicial sin base seleccionada para asegurar que el esquema exista
  const bootstrapConn = await mysql.createConnection({
    host,
    port,
    user,
    password,
  });

  try {
    await bootstrapConn.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await bootstrapConn.end();
  }

  // 2. Pool principal con sentencias preparadas y sin multipleStatements
  const pool = mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    dateStrings: true,
  });

  // 3. Ejecutar esquema SQL tabla por tabla
  const schemaSql = fs.readFileSync(MYSQL_SCHEMA_PATH, 'utf8');
  const statements = splitSqlStatements(schemaSql);
  for (const stmt of statements) {
    await pool.query(stmt);
  }

  const db = wrapMysqlExecutor(pool, pool);
  await seedInitialData(db);
  return db;
}

/**
 * Inicializa conexión SQLite local o en memoria (`:memory:`).
 *
 * @param {string} dbPath
 */
async function initSqliteDatabase(dbPath) {
  const isMemory = dbPath === ':memory:';
  const resolvedPath = isMemory ? ':memory:' : path.resolve(dbPath);

  if (!isMemory) {
    const parentDir = path.dirname(resolvedPath);
    fs.mkdirSync(parentDir, { recursive: true });
  }

  const rawDb = new DatabaseSync(resolvedPath);
  rawDb.exec('PRAGMA foreign_keys = ON;');
  if (!isMemory) {
    rawDb.exec('PRAGMA journal_mode = WAL;');
    rawDb.exec('PRAGMA busy_timeout = 5000;');
  }

  const schemaSql = fs.readFileSync(SQLITE_SCHEMA_PATH, 'utf8');
  rawDb.exec(schemaSql);

  const db = wrapSqliteDatabase(rawDb);
  await seedInitialData(db);
  return db;
}

/**
 * Punto de entrada principal para abrir e inicializar la base de datos configurada.
 *
 * @param {string | {
 *   client?: 'mysql' | 'sqlite',
 *   dbPath?: string,
 *   host?: string,
 *   port?: number,
 *   user?: string,
 *   password?: string,
 *   database?: string
 * }} [options={}]
 */
async function initDatabase(options = {}) {
  if (typeof options === 'string') {
    return initSqliteDatabase(options);
  }

  const requestedClient = (
    options.client ||
    (options.dbPath ? 'sqlite' : process.env.DB_CLIENT || 'mysql')
  ).toLowerCase();

  if (requestedClient === 'sqlite') {
    const dbPath = options.dbPath || process.env.DB_PATH || './data/hospital_fesc.db';
    return initSqliteDatabase(dbPath);
  }

  return initMysqlDatabase(options);
}

/**
 * Ejecuta una función asíncrona dentro de una transacción atómica.
 *
 * @template T
 * @param {{ withTransaction: (fn: (tx: any) => Promise<T>) => Promise<T> }} db
 * @param {(tx: any) => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withTransaction(db, fn) {
  return db.withTransaction(fn);
}

module.exports = {
  initDatabase,
  withTransaction,
};
