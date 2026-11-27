/**
 * @file scripts/reset-db.js
 * @description Restaura la base de datos activa (MySQL/XAMPP o SQLite) a estado
 * limpio de operación:
 * - Elimina todas las citas (`appointments`), bloqueos (`blocked_dates`) y bitácora (`audit_logs`).
 * - Reinicia los contadores autoincrementales.
 * - Restaura los 5 servicios veterinarios activos y el horario oficial (lun-vie 10:00-18:00).
 * - Conserva intacta la cuenta del administrador único (`id = 1`), limpiando bloqueos temporales.
 *
 * Uso: `npm run reset-db` (o `npm.cmd run reset-db` en PowerShell).
 */

require('dotenv').config();

const { initDatabase } = require('../src/db/database');
const { DEFAULT_SCHEDULE_RULES } = require('../src/config/constants');

async function resetDatabase() {
  let db;
  try {
    db = await initDatabase();

    await db.withTransaction(async (tx) => {
      await tx.run('DELETE FROM appointments');
      await tx.run('DELETE FROM blocked_dates');
      await tx.run('DELETE FROM audit_logs');
      await tx.run('UPDATE services SET active = 1, duration_minutes = 60');

      for (const rule of DEFAULT_SCHEDULE_RULES) {
        await tx.run(
          `UPDATE schedule_rules
           SET is_open = ?, start_time = ?, end_time = ?, slot_minutes = ?, capacity_per_slot = ?
           WHERE day_of_week = ?`,
          [
            rule.is_open,
            rule.start_time,
            rule.end_time,
            rule.slot_minutes,
            rule.capacity_per_slot,
            rule.day_of_week,
          ]
        );
      }

      await tx.run(
        'UPDATE admin_account SET failed_attempts = 0, locked_until = NULL WHERE id = 1'
      );
    });

    // Reiniciar contadores autoincrementales según motor
    if (db.dialect === 'mysql') {
      await db.run('ALTER TABLE appointments AUTO_INCREMENT = 1');
      await db.run('ALTER TABLE blocked_dates AUTO_INCREMENT = 1');
      await db.run('ALTER TABLE audit_logs AUTO_INCREMENT = 1');
    } else {
      await db.run(
        "DELETE FROM sqlite_sequence WHERE name IN ('appointments', 'blocked_dates', 'audit_logs')"
      );
    }

    const counts = {
      appointments: (await db.get('SELECT COUNT(*) AS total FROM appointments')).total,
      blockedDates: (await db.get('SELECT COUNT(*) AS total FROM blocked_dates')).total,
      auditLogs: (await db.get('SELECT COUNT(*) AS total FROM audit_logs')).total,
      activeServices: (await db.get('SELECT COUNT(*) AS total FROM services WHERE active = 1')).total,
      scheduleRules: (await db.get('SELECT COUNT(*) AS total FROM schedule_rules')).total,
      adminAccount: (await db.get('SELECT COUNT(*) AS total FROM admin_account')).total,
    };

    console.log('======================================================================');
    console.log(' Base de datos restaurada correctamente');
    console.log(` Motor: ${db.dialect === 'mysql' ? 'MySQL / MariaDB (XAMPP)' : 'SQLite'}`);
    console.log(` - Citas:             ${counts.appointments}`);
    console.log(` - Bloqueos:          ${counts.blockedDates}`);
    console.log(` - Bitácora:          ${counts.auditLogs}`);
    console.log(` - Servicios activos: ${counts.activeServices}`);
    console.log(` - Reglas de horario: ${counts.scheduleRules}`);
    console.log(` - Admin único:       ${counts.adminAccount} (conservado intacto)`);
    console.log('======================================================================');
  } catch (err) {
    console.error('[ERROR] No se pudo restaurar la base de datos:', err.message);
    if ((process.env.DB_CLIENT || 'mysql').toLowerCase() === 'mysql') {
      console.error(
        '        Verifica que MySQL/MariaDB esté encendido en XAMPP (C:\\xampp\\xampp-control.exe).'
      );
    }
    process.exitCode = 1;
  } finally {
    if (db) {
      try {
        await db.close();
      } catch {
        // Ignorar
      }
    }
  }
}

resetDatabase();
