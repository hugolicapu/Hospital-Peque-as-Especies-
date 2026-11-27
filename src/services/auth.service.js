/**
 * @file src/services/auth.service.js
 * @description Servicio de autenticación y seguridad para el modelo estricto
 * de Administrador Único (`id = 1` en `admin_account`).
 *
 * Controles de seguridad implementados:
 * - Solo puede existir 1 cuenta (`id = 1`). No hay registro público.
 * - Contraseñas cifradas con bcryptjs (12 rondas por defecto).
 * - Conteo de intentos fallidos y bloqueo temporal de 15 minutos tras 5 fallos.
 * - Sesión exclusiva: guardar `active_session_id` invalida automáticamente
 *   cualquier sesión previa abierta en otro navegador o dispositivo.
 * - Registro completo en `audit_logs` de cada acceso, fallo, bloqueo o cambio.
 */

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { SECURITY_CONFIG } = require('../config/constants');
const { AppError } = require('../middleware/error.middleware');
const { usernameSchema, strongPasswordSchema } = require('../validators/admin.validator');
const { logAuditEvent } = require('./audit.service');

/**
 * Compara dos cadenas en tiempo constante para evitar ataques de temporización.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Indica si ya existe la cuenta única de administrador en la base de datos.
 *
 * @param {object} db
 * @returns {Promise<boolean>}
 */
async function isAdminConfigured(db) {
  const row = await db.get('SELECT id FROM admin_account WHERE id = 1');
  return Boolean(row);
}

/**
 * Recupera la fila de la cuenta única de administrador (`id = 1`).
 *
 * @param {object} db
 * @returns {Promise<Record<string, any> | null>}
 */
async function getAdminAccount(db) {
  return db.get(
    `SELECT
      id, username, password_hash, active_session_id,
      failed_attempts, locked_until, updated_at
    FROM admin_account
    WHERE id = 1`
  );
}

/**
 * Crea o reemplaza la cuenta única de administrador (`id = 1`).
 * Compatible con MySQL/MariaDB (`ON DUPLICATE KEY UPDATE`) y SQLite (`ON CONFLICT`).
 *
 * @param {object} db
 * @param {string} username
 * @param {string} plainPassword
 * @returns {Promise<{ id: number, username: string, updatedAt: string }>}
 */
async function upsertSingleAdmin(db, username, plainPassword) {
  const validUsername = usernameSchema.parse(username);
  const validPassword = strongPasswordSchema.parse(plainPassword);

  const passwordHash = await bcrypt.hash(validPassword, SECURITY_CONFIG.BCRYPT_ROUNDS);
  const nowIso = new Date().toISOString();

  if (db.dialect === 'mysql') {
    await db.run(
      `INSERT INTO admin_account (
        id, username, password_hash, active_session_id, failed_attempts, locked_until, updated_at
      )
      VALUES (1, ?, ?, NULL, 0, NULL, ?)
      ON DUPLICATE KEY UPDATE
        username = VALUES(username),
        password_hash = VALUES(password_hash),
        active_session_id = NULL,
        failed_attempts = 0,
        locked_until = NULL,
        updated_at = VALUES(updated_at)`,
      [validUsername, passwordHash, nowIso]
    );
  } else {
    await db.run(
      `INSERT INTO admin_account (
        id, username, password_hash, active_session_id, failed_attempts, locked_until, updated_at
      )
      VALUES (1, ?, ?, NULL, 0, NULL, ?)
      ON CONFLICT(id) DO UPDATE SET
        username = excluded.username,
        password_hash = excluded.password_hash,
        active_session_id = NULL,
        failed_attempts = 0,
        locked_until = NULL,
        updated_at = excluded.updated_at`,
      [validUsername, passwordHash, nowIso]
    );
  }

  await logAuditEvent(db, {
    eventType: 'ADMIN_ACCOUNT_CONFIGURED',
    actor: validUsername,
    details: 'Cuenta de administrador único creada o restablecida.',
  });

  return {
    id: 1,
    username: validUsername,
    updatedAt: nowIso,
  };
}

/**
 * Verifica las credenciales del administrador único y, si son válidas,
 * registra el nuevo `sessionId` como única sesión activa permitida.
 *
 * @param {object} db
 * @param {{ username: string, password: string, sessionId: string, ipAddress?: string }} params
 * @returns {Promise<{ username: string, replacedPreviousSession: boolean }>}
 */
async function verifyAdminLogin(db, { username, password, sessionId, ipAddress = '' }) {
  const account = await getAdminAccount(db);

  if (!account) {
    throw new AppError(
      'La cuenta de administrador aún no ha sido configurada en el servidor.',
      503
    );
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // Verificar si la cuenta se encuentra en periodo de bloqueo temporal
  if (account.locked_until) {
    const lockUntilMs = Date.parse(account.locked_until);
    if (!Number.isNaN(lockUntilMs) && lockUntilMs > nowMs) {
      const remainingMinutes = Math.max(1, Math.ceil((lockUntilMs - nowMs) / 60000));
      await logAuditEvent(db, {
        eventType: 'ADMIN_LOGIN_BLOCKED',
        actor: username || account.username,
        ipAddress,
        details: `Intento rechazado durante bloqueo temporal (restan ${remainingMinutes} min).`,
      });
      throw new AppError(
        `La cuenta está bloqueada temporalmente por demasiados intentos fallidos. Intenta nuevamente en ${remainingMinutes} minuto(s).`,
        423
      );
    }
  }

  // Se ejecuta bcrypt.compare siempre para evitar ataques de temporización
  const passwordMatches = await bcrypt.compare(password, account.password_hash);
  const usernameMatches = safeStringEqual(username, account.username);

  if (!usernameMatches || !passwordMatches) {
    const lockExpired =
      account.locked_until && Date.parse(account.locked_until) <= nowMs;
    const nextAttempts = (lockExpired ? 0 : Number(account.failed_attempts || 0)) + 1;

    if (nextAttempts >= SECURITY_CONFIG.MAX_FAILED_LOGIN_ATTEMPTS) {
      const lockedUntilIso = new Date(
        nowMs + SECURITY_CONFIG.LOCKOUT_MINUTES * 60 * 1000
      ).toISOString();

      await db.run(
        `UPDATE admin_account
         SET failed_attempts = ?, locked_until = ?, updated_at = ?
         WHERE id = 1`,
        [nextAttempts, lockedUntilIso, nowIso]
      );

      await logAuditEvent(db, {
        eventType: 'ADMIN_ACCOUNT_LOCKED',
        actor: username || account.username,
        ipAddress,
        details: `Cuenta bloqueada ${SECURITY_CONFIG.LOCKOUT_MINUTES} minutos tras ${nextAttempts} intentos fallidos.`,
      });

      throw new AppError(
        `Demasiados intentos fallidos. La cuenta ha sido bloqueada temporalmente durante ${SECURITY_CONFIG.LOCKOUT_MINUTES} minutos.`,
        423
      );
    }

    await db.run(
      `UPDATE admin_account
       SET failed_attempts = ?, locked_until = NULL, updated_at = ?
       WHERE id = 1`,
      [nextAttempts, nowIso]
    );

    await logAuditEvent(db, {
      eventType: 'ADMIN_LOGIN_FAILED',
      actor: username || 'desconocido',
      ipAddress,
      details: `Credenciales inválidas (intento ${nextAttempts} de ${SECURITY_CONFIG.MAX_FAILED_LOGIN_ATTEMPTS}).`,
    });

    throw new AppError('Usuario o contraseña incorrectos.', 401);
  }

  // Credenciales válidas: reemplaza cualquier sesión previa (sesión única exclusiva)
  const replacedPreviousSession = Boolean(
    account.active_session_id && account.active_session_id !== sessionId
  );

  await db.run(
    `UPDATE admin_account
     SET active_session_id = ?, failed_attempts = 0, locked_until = NULL, updated_at = ?
     WHERE id = 1`,
    [sessionId, nowIso]
  );

  await logAuditEvent(db, {
    eventType: 'ADMIN_LOGIN_SUCCESS',
    actor: account.username,
    ipAddress,
    details: replacedPreviousSession
      ? 'Inicio de sesión exitoso (se invalidó la sesión previa activa).'
      : 'Inicio de sesión exitoso.',
  });

  return {
    username: account.username,
    replacedPreviousSession,
  };
}

/**
 * Comprueba que el `sessionId` actual coincida con la única sesión autorizada.
 *
 * @param {object} db
 * @param {string} sessionId
 * @returns {Promise<boolean>}
 */
async function validateActiveSession(db, sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    return false;
  }
  const row = await db.get('SELECT active_session_id FROM admin_account WHERE id = 1');

  if (!row || !row.active_session_id) {
    return false;
  }

  return safeStringEqual(row.active_session_id, sessionId);
}

/**
 * Limpia `active_session_id` solo si corresponde a la sesión que se está cerrando.
 *
 * @param {object} db
 * @param {string} sessionId
 * @param {string} [username='admin']
 * @param {string} [ipAddress='']
 * @param {string} [reason='Cierre de sesión voluntario.']
 */
async function clearActiveSession(
  db,
  sessionId,
  username = 'admin',
  ipAddress = '',
  reason = 'Cierre de sesión voluntario.'
) {
  if (sessionId) {
    await db.run(
      `UPDATE admin_account
       SET active_session_id = NULL, updated_at = ?
       WHERE id = 1 AND active_session_id = ?`,
      [new Date().toISOString(), sessionId]
    );
  }

  await logAuditEvent(db, {
    eventType: 'ADMIN_LOGOUT',
    actor: username || 'admin',
    ipAddress,
    details: reason,
  });
}

/**
 * Cambia la contraseña del administrador único verificando primero la actual.
 *
 * @param {object} db
 * @param {{ currentPassword: string, newPassword: string, ipAddress?: string }} params
 * @returns {Promise<{ username: string, updatedAt: string }>}
 */
async function changeAdminPassword(db, { currentPassword, newPassword, ipAddress = '' }) {
  const account = await getAdminAccount(db);
  if (!account) {
    throw new AppError(
      'La cuenta de administrador aún no ha sido configurada en el servidor.',
      503
    );
  }

  const currentMatches = await bcrypt.compare(currentPassword, account.password_hash);
  if (!currentMatches) {
    await logAuditEvent(db, {
      eventType: 'ADMIN_PASSWORD_CHANGE_FAILED',
      actor: account.username,
      ipAddress,
      details: 'La contraseña actual proporcionada no coincide.',
    });
    throw new AppError('La contraseña actual es incorrecta.', 400);
  }

  const validNewPassword = strongPasswordSchema.parse(newPassword);
  const newHash = await bcrypt.hash(validNewPassword, SECURITY_CONFIG.BCRYPT_ROUNDS);
  const nowIso = new Date().toISOString();

  await db.run(
    `UPDATE admin_account
     SET password_hash = ?, updated_at = ?
     WHERE id = 1`,
    [newHash, nowIso]
  );

  await logAuditEvent(db, {
    eventType: 'ADMIN_PASSWORD_CHANGED',
    actor: account.username,
    ipAddress,
    details: 'Contraseña del administrador actualizada correctamente.',
  });

  return {
    username: account.username,
    updatedAt: nowIso,
  };
}

module.exports = {
  isAdminConfigured,
  getAdminAccount,
  upsertSingleAdmin,
  verifyAdminLogin,
  validateActiveSession,
  clearActiveSession,
  changeAdminPassword,
};
