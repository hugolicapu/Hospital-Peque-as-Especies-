/**
 * @file src/server.js
 * @description Punto de entrada ejecutable del servidor web para el Sistema de Citas
 * del Hospital de Pequeñas Especies · UNAM FES Cuautitlán (Campo 4).
 *
 * Preparado tanto para ejecución local (XAMPP) como para despliegue en la nube
 * (Railway, Render, Fly.io, Docker o VPS):
 * - Escucha en `HOST` (`0.0.0.0` por defecto) y `PORT` (`3000` por defecto).
 * - Exige `SESSION_SECRET` robusto cuando `NODE_ENV=production`.
 * - Si no existe cuenta de administrador todavía y se proporcionan
 *   `ADMIN_USERNAME` + `ADMIN_PASSWORD`, inicializa la cuenta única una sola vez
 *   (útil en despliegues cloud sin terminal interactiva).
 */

require('dotenv').config();

const { createApp } = require('./app');
const { isAdminConfigured, upsertSingleAdmin } = require('./services/auth.service');

const HOST = process.env.HOST || '0.0.0.0';
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
      '[SEGURIDAD] En producción debes configurar SESSION_SECRET con al menos 32 caracteres aleatorios.'
    );
    process.exit(1);
  }

  let app;
  let db;
  let adminPath;
  let appMode;
  try {
    ({ app, db, adminPath, appMode } = await createApp());
  } catch (err) {
    console.error('[ERROR] No fue posible conectar con la base de datos:', err.message);
    if ((process.env.DB_CLIENT || 'mysql').toLowerCase() === 'mysql') {
      console.error(
        '        Verifica que MySQL/MariaDB esté activo y que las variables DB_* o MYSQL_URL sean correctas.'
      );
    }
    process.exit(1);
  }

  let adminReady = await isAdminConfigured(db);

  // Arranque inicial automático del administrador único en entornos cloud sin shell
  if (!adminReady && process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
    try {
      const created = await upsertSingleAdmin(
        db,
        process.env.ADMIN_USERNAME,
        process.env.ADMIN_PASSWORD
      );
      adminReady = true;
      console.log(
        `[SEGURIDAD] Cuenta única de administrador "${created.username}" creada automáticamente.`
      );
      console.warn(
        '[RECOMENDACIÓN] Elimina ADMIN_USERNAME y ADMIN_PASSWORD de las variables de entorno tras este primer arranque.'
      );
    } catch (setupErr) {
      console.error(
        '[SEGURIDAD] No se pudo inicializar el administrador desde variables de entorno:',
        setupErr.message
      );
    }
  }

  const server = app.listen(PORT, HOST, () => {
    const dbLabel =
      db.dialect === 'mysql'
        ? `MySQL / MariaDB -> ${process.env.DB_NAME || process.env.MYSQLDATABASE || 'hospital_fesc_citas'}`
        : `SQLite -> ${process.env.DB_PATH || './data/hospital_fesc.db'}`;

    console.log('======================================================================');
    console.log(' Hospital de Pequeñas Especies · UNAM FES Cuautitlán (Campo 4)');
    console.log(` Entorno / Modo:              ${isProduction ? 'PRODUCCIÓN' : 'DESARROLLO'} (${appMode})`);
    console.log(` Base de datos activa:        ${dbLabel}`);
    console.log(` Escuchando en:               http://${HOST}:${PORT}`);
    if (appMode === 'all' || appMode === 'public') {
      console.log(` Portal público de citas:     http://localhost:${PORT}/`);
    }
    if (appMode === 'all' || appMode === 'admin') {
      console.log(` Panel de administrador:      http://localhost:${PORT}${adminPath}`);
    }
    console.log(` Salud del servicio:          http://localhost:${PORT}/health`);
    console.log('======================================================================');

    if (!adminReady) {
      console.warn('');
      console.warn('[AVISO] Todavía no se ha configurado la cuenta de administrador único.');
      console.warn('        Ejecuta: npm run setup-admin   (o define ADMIN_USERNAME y ADMIN_PASSWORD en el primer arranque).');
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
