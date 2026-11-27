/**
 * @file src/services/audit.service.js
 * @description Servicio de bitácora de auditoría (`audit_logs`).
 * Registra eventos de seguridad (accesos, intentos fallidos, bloqueos, cambios
 * de contraseña) y modificaciones administrativas para trazabilidad institucional.
 */

/**
 * Inserta un nuevo evento en la tabla `audit_logs`.
 *
 * @param {object} db Adaptador unificado de base de datos (MySQL/XAMPP o SQLite).
 * @param {{ eventType: string, actor: string, ipAddress?: string, details?: string | Record<string, unknown> }} event
 */
async function logAuditEvent(db, { eventType, actor, ipAddress = '', details = '' }) {
  const serializedDetails =
    typeof details === 'string' ? details : JSON.stringify(details ?? '');

  await db.run(
    `INSERT INTO audit_logs (event_type, actor, ip_address, details, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      String(eventType || 'UNKNOWN_EVENT'),
      String(actor || 'system'),
      String(ipAddress || ''),
      serializedDetails,
      new Date().toISOString(),
    ]
  );
}

/**
 * Obtiene los registros más recientes de la bitácora de auditoría.
 *
 * @param {object} db
 * @param {number|string} [limit=50] Número máximo de eventos a devolver (acotado entre 1 y 200).
 * @returns {Promise<Array<{ id: number, eventType: string, actor: string, ipAddress: string, details: string, createdAt: string }>>}
 */
async function getRecentAuditLogs(db, limit = 50) {
  const parsedLimit = Number.parseInt(limit, 10);
  const safeLimit = Number.isNaN(parsedLimit)
    ? 50
    : Math.min(Math.max(parsedLimit, 1), 200);

  // Nota: safeLimit ya fue validado como entero acotado [1..200] para compatibilidad estricta con MySQL prepared statements
  return db.all(
    `SELECT
      id,
      event_type AS eventType,
      actor,
      ip_address AS ipAddress,
      details,
      created_at AS createdAt
    FROM audit_logs
    ORDER BY id DESC
    LIMIT ${safeLimit}`
  );
}

module.exports = {
  logAuditEvent,
  getRecentAuditLogs,
};
