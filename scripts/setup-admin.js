/**
 * @file scripts/setup-admin.js
 * @description Script de consola para crear o restablecer la cuenta de
 * Administrador Único (`id = 1`) del Hospital de Pequeñas Especies UNAM FESC.
 *
 * Modos de uso:
 * 1. Interactivo (recomendado en instalación manual):
 *    `npm run setup-admin`
 * 2. No interactivo (CI, despliegue automatizado o scripts):
 *    Definiendo variables de entorno `ADMIN_USERNAME` y `ADMIN_PASSWORD`.
 */

require('dotenv').config();

const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');
const { initDatabase } = require('../src/db/database');
const {
  isAdminConfigured,
  getAdminAccount,
  upsertSingleAdmin,
} = require('../src/services/auth.service');
const {
  usernameSchema,
  strongPasswordSchema,
} = require('../src/validators/admin.validator');

/**
 * Lee una contraseña desde terminal ocultando los caracteres escritos cuando
 * la entrada es un TTY interactivo; si no es TTY, lee normalmente con readline.
 *
 * @param {string} promptText
 * @returns {Promise<string>}
 */
function readHiddenPassword(promptText) {
  return new Promise((resolve, reject) => {
    if (!input.isTTY) {
      const rl = readline.createInterface({ input, output });
      rl.question(promptText)
        .then((answer) => {
          rl.close();
          resolve(answer);
        })
        .catch((err) => {
          rl.close();
          reject(err);
        });
      return;
    }

    output.write(promptText);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    let password = '';

    function cleanup() {
      input.removeListener('data', onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
    }

    function onData(chunk) {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          output.write('\n');
          cleanup();
          resolve(password);
          return;
        }
        // Ctrl+C cancela el asistente limpiamente
        if (ch === '\u0003') {
          output.write('\nOperación cancelada por el usuario.\n');
          cleanup();
          process.exit(1);
        }
        // Retroceso (Backspace / Delete)
        if (ch === '\u0008' || ch === '\u007f') {
          if (password.length > 0) {
            password = password.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }
        password += ch;
        output.write('*');
      }
    }

    input.on('data', onData);
  });
}

async function runSetup() {
  const dbPath = process.env.DB_PATH || './data/hospital_fesc.db';
  const db = initDatabase(dbPath);

  try {
    console.log('======================================================================');
    console.log(' Configuración de Administrador Único — Hospital de Pequeñas Especies');
    console.log(' UNAM · FES Cuautitlán (Campo 4)');
    console.log('======================================================================');

    const envUsername = process.env.ADMIN_USERNAME;
    const envPassword = process.env.ADMIN_PASSWORD;

    // Modo automatizado mediante variables de entorno
    if (envUsername && envPassword) {
      const result = upsertSingleAdmin(db, envUsername, envPassword);
      console.log(
        `[OK] Cuenta de administrador único configurada correctamente para el usuario "${result.username}".`
      );
      return;
    }

    // Modo interactivo por terminal
    if (isAdminConfigured(db)) {
      const existing = getAdminAccount(db);
      console.log(
        `\n[AVISO] Ya existe una cuenta de administrador único ("${existing.username}").`
      );
      console.log(
        '        Continuar reemplazará sus credenciales y cerrará cualquier sesión activa.\n'
      );
    }

    const rl = readline.createInterface({ input, output });
    let username = '';
    try {
      while (!username) {
        const rawUser = await rl.question('Usuario administrador (ej. admin.fesc): ');
        const check = usernameSchema.safeParse(rawUser);
        if (!check.success) {
          console.error(`  ✗ ${check.error.issues[0].message}`);
          continue;
        }
        username = check.data;
      }
    } finally {
      rl.close();
    }

    console.log(
      '\nPolítica de contraseña: mínimo 10 caracteres, 1 mayúscula, 1 minúscula, 1 número y 1 símbolo.'
    );

    let password = '';
    while (!password) {
      const firstAttempt = await readHiddenPassword('Nueva contraseña: ');
      const check = strongPasswordSchema.safeParse(firstAttempt);
      if (!check.success) {
        for (const issue of check.error.issues) {
          console.error(`  ✗ ${issue.message}`);
        }
        continue;
      }

      const confirmation = await readHiddenPassword('Confirma la contraseña: ');
      if (firstAttempt !== confirmation) {
        console.error('  ✗ Las contraseñas no coinciden. Intenta de nuevo.');
        continue;
      }

      password = check.data;
    }

    const result = upsertSingleAdmin(db, username, password);
    console.log(
      `\n[OK] Cuenta de administrador único guardada exitosamente para "${result.username}".`
    );
    console.log('     Ya puedes iniciar el servidor con "npm start" y acceder en /admin.');
  } catch (err) {
    if (err?.name === 'ZodError') {
      console.error('\n[ERROR] Datos inválidos para la cuenta de administrador:');
      for (const issue of err.issues) {
        console.error(`  - ${issue.message}`);
      }
    } else {
      console.error('\n[ERROR] No se pudo configurar la cuenta de administrador:', err.message);
    }
    process.exitCode = 1;
  } finally {
    try {
      db.close();
    } catch {
      // Ignorar si ya estaba cerrada
    }
  }
}

runSetup();
