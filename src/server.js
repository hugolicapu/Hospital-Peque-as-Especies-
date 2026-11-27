/**
 * @file src/server.js
 * @description Punto de entrada ejecutable del servidor web para el Sistema de Citas
 * del Hospital de Pequeñas Especies · UNAM FES Cuautitlán (Campo 4).
 */

require('dotenv').config();

const { createApp } = require('./app');
const { isAdminConfigured } = require('./services/auth.service');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const isProduction = process.env.NODE_ENV === 'production';

async function startServer() {
  if (
    isProduction &&
    (!process.env.SESSION_SECRET ||
      process.env.SESSION_SECRET.length < 32 ||
      process.env.SESSION_SECRET.includes('cambia-este-secreto'))
  ) {
    console.error(
      '[SEGURIDAD] En producción debes configurar SESSION_SECRET en .env con al menos 32 caracteres aleatorios.'
    );
    process.exit(1);
  }

  let app;
  let db;
  try {
    ({ app, db } = await createApp());
  } catch (err) {
    console.error('[ERROR] No fue posible conectar con la base de datos:', err.message);
    if ((process.env.DB_CLIENT || 'mysql').toLowerCase() === 'mysql') {
      console.error(
        '        Verifica que MySQL/MariaDB esté encendido en XAMPP (C:\\xampp\\xampp-control.exe).'
      );
    }
    process.exit(1);
  }

  const adminReady = await isAdminConfigured(db);

  const server = app.listen(PORT, () => {
    const dbLabel =
      db.dialect === 'mysql'
        ? `MySQL / MariaDB (XAMPP) -> ${process.env.DB_NAME || 'hospital_fesc_citas'}`
        : `SQLite -> ${process.env.DB_PATH || './data/hospital_fesc.db'}`;

    console.log('======================================================================');
    console.log(' Hospital de Pequeñas Especies · UNAM FES Cuautitlán (Campo 4)');
    console.log(` Base de datos activa:        ${dbLabel}`);
    console.log(` Portal público de citas:     http://localhost:${PORT}/`);
    console.log(` Panel de administrador:      http://localhost:${PORT}/admin`);
    console.log('======================================================================');

    if (!adminReady) {
      console.warn('');
      console.warn('[AVISO] Todavía no se ha configurado la cuenta de administrador único.');
      console.warn('        Ejecuta: npm run setup-admin   (o npm.cmd run setup-admin en PowerShell)');
      console.warn('        antes de intentar iniciar sesión en /admin.');
      console.warn('');
    }
  });

  function gracefulShutdown(signal) {
    console.log(`\nRecibida señal ${signal}. Cerrando servidor de forma segura...`);
    server.close(async () => {
      try {
        await db.close();
      } catch {
        // Ignorar si la conexión ya estaba cerrada
      }
      process.exit(0);
    });
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

startServer();
