/**
 * @file src/server.js
 * @description Punto de entrada ejecutable del servidor web para el Sistema de Citas
 * del Hospital de Pequeñas Especies · UNAM FES Cuautitlán (Campo 4).
 *
 * Carga variables de entorno desde `.env`, verifica la configuración mínima de
 * seguridad, arranca la aplicación Express y escucha señales de apagado ordenado.
 */

require('dotenv').config();

const { createApp } = require('./app');
const { isAdminConfigured } = require('./services/auth.service');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const isProduction = process.env.NODE_ENV === 'production';

// En producción es obligatorio definir un SESSION_SECRET fuerte y propio
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

const { app, db } = createApp();

const server = app.listen(PORT, () => {
  console.log('======================================================================');
  console.log(' Hospital de Pequeñas Especies · UNAM FES Cuautitlán (Campo 4)');
  console.log(` Servidor iniciado en:        http://localhost:${PORT}`);
  console.log(` Portal público de citas:     http://localhost:${PORT}/`);
  console.log(` Panel de administrador:      http://localhost:${PORT}/admin`);
  console.log('======================================================================');

  if (!isAdminConfigured(db)) {
    console.warn('');
    console.warn('[AVISO] Todavía no se ha configurado la cuenta de administrador único.');
    console.warn('        Ejecuta: npm run setup-admin   (o npm.cmd run setup-admin en PowerShell)');
    console.warn('        antes de intentar iniciar sesión en /admin.');
    console.warn('');
  }
});

/**
 * Cierra limpiamente el servidor HTTP y la conexión SQLite al recibir SIGINT/SIGTERM.
 */
function gracefulShutdown(signal) {
  console.log(`\nRecibida señal ${signal}. Cerrando servidor de forma segura...`);
  server.close(() => {
    try {
      db.close();
    } catch {
      // Ignorar si la conexión ya estaba cerrada
    }
    process.exit(0);
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
