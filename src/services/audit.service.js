/**
 * @file src/services/audit.service.js
 * @description Servicio de bitácora de auditoría (`audit_logs`).
 * Registra eventos de seguridad (accesos, intentos fallidos, bloqueos, cambios
 * de contraseña) y modificaciones administrativas para trazabilidad institucional.
 */

/**
 * Inserta un nuevo evento en la tabla `audit_logs`.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ eventType: string, actor: string, ipAddress?: string, details?: string | Record<string, unknown> }} event
 */
function logAuditEvent(db, { eventType, actor, ipAddress = '', details = '' }) {
  const serializedDetails =
    typeof details === 'string' ? details : JSON.stringify(details ?? '');

  const stmt = db.prepare(`
    INSERT INTO audit_logs (event_type, actor, ip_address, details, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  stmt.run(
    String(eventType || 'UNKNOWN_EVENT'),
    String(actor || 'system'),
    String(ipAddress || ''),
    serializedDetails,
    new Date().toISOString()
  );
}

/**
 * Obtiene los registros más recientes de la bitácora de auditoría.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} [limit=50] Número máximo de eventos a devolver (acotado entre 1 y 200).
 * @returns {Array<{ id: number, eventType: string, actor: string, ipAddress: string, details: string, createdAt: string }>}
 */
function getRecentAuditLogs(db, limit = 50) {
  const parsedLimit = Number.parseInt(limit, 10);
  const safeLimit = Number.isNaN(parsedLimit)
    ? 50
    : Math.min(Math.max(parsedLimit, 1), 200);

  const stmt = db.prepare(`
    SELECT
      id,
      event_type AS eventType,
      actor,
      ip_address AS ipAddress,
      details,
      created_at AS createdAt
    FROM audit_logs
    ORDER BY id DESC
    LIMIT ?
  `);

  return stmt.all(safeLimit);
}

module.exports = {
  logAuditEvent,
  getRecentAuditLogs,
};
