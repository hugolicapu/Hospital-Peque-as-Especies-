/**
 * @file tests/api.test.js
 * @description Pruebas automatizadas de integración y seguridad para el Sistema
 * de Citas y Panel de Administrador Único del Hospital de Pequeñas Especies UNAM FESC.
 *
 * Utiliza el ejecutor nativo `node:test` y `fetch` de Node.js 22 (sin dependencias extra).
 * Verifica:
 *  - Disponibilidad de páginas HTML, Bootstrap local y cabeceras Helmet CSP.
 *  - Flujo público completo (configuración, disponibilidad, creación, consulta y cancelación).
 *  - Seguridad del administrador único (401 sin sesión, 403 sin CSRF, sesión única exclusiva,
 *    bloqueo temporal tras intentos fallidos y bitácora de auditoría).
 *  - Interconexión inmediata entre cambios del administrador (confirmar citas, bloquear horarios)
 *    y lo que ve el usuario público.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/app');
const { upsertSingleAdmin } = require('../src/services/auth.service');

/**
 * Cliente HTTP ligero con manejo automático de cookies (para simular navegadores independientes).
 */
class TestClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookies = new Map();
    this.csrfToken = null;
  }

  getCookieHeader() {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  storeCookies(response) {
    const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    for (const raw of setCookies) {
      const [pair] = raw.split(';');
      const eqIndex = pair.indexOf('=');
      if (eqIndex > 0) {
        const name = pair.slice(0, eqIndex).trim();
        const value = pair.slice(eqIndex + 1).trim();
        this.cookies.set(name, value);
      }
    }
  }

  async request(path, options = {}) {
    const headers = {
      Accept: 'application/json',
      ...(options.headers || {}),
    };
    const cookieHeader = this.getCookieHeader();
    if (cookieHeader) headers.Cookie = cookieHeader;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.useCsrf && this.csrfToken) headers['X-CSRF-Token'] = this.csrfToken;

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    this.storeCookies(response);
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json')
      ? await response.json()
      : await response.text();
    return { status: response.status, headers: response.headers, data };
  }

  async fetchCsrf() {
    const res = await this.request('/api/admin/csrf-token');
    assert.equal(res.status, 200);
    this.csrfToken = res.data.data.csrfToken;
    return this.csrfToken;
  }
}

/**
 * Calcula el próximo día hábil (lunes a viernes) a partir de mañana en formato YYYY-MM-DD.
 */
function getNextWeekdayIso() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  while (date.getDay() === 0 || date.getDay() === 6) {
    date.setDate(date.getDate() + 1);
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

test('Suite completa de integración, sincronización y seguridad Single-Admin', async (t) => {
  const { app, db } = await createApp({
    dbPath: ':memory:',
    sessionSecret: 'secreto-de-pruebas-automatizadas-muy-largo-1234567890',
    sessionTimeoutMinutes: 15,
    disableRateLimit: true,
  });

  // Configuramos el administrador único en la BD en memoria
  await upsertSingleAdmin(db, 'admin_fesc', 'UnamFesc#2026!');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (db && typeof db.close === 'function') await db.close();
  });

  const publicClient = new TestClient(baseUrl);
  const adminA = new TestClient(baseUrl);
  const adminB = new TestClient(baseUrl);
  const targetDate = getNextWeekdayIso();
  let createdFolio = null;
  let createdAppointmentId = null;

  await t.test('1. Sirve páginas HTML, Bootstrap local y cabeceras de seguridad Helmet', async () => {
    const home = await publicClient.request('/');
    assert.equal(home.status, 200);
    assert.match(home.data, /Hospital de Pequeñas Especies/i);
    assert.ok(home.headers.get('content-security-policy'), 'Debe incluir cabecera CSP');
    assert.equal(home.headers.get('x-content-type-options'), 'nosniff');

    const adminPage = await publicClient.request('/admin');
    assert.equal(adminPage.status, 200);
    assert.match(adminPage.data, /Administrador/i);
    assert.match(adminPage.headers.get('cache-control') || '', /no-store/i);
    assert.match(adminPage.headers.get('x-robots-tag') || '', /noindex/i);
    assert.equal(adminPage.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(adminPage.headers.get('x-frame-options'), 'DENY');
    assert.ok(adminPage.headers.get('permissions-policy'), 'Debe incluir Permissions-Policy');

    const bootstrapCss = await publicClient.request('/vendor/bootstrap/css/bootstrap.min.css');
    assert.equal(bootstrapCss.status, 200);

    // Verifica endpoint de salud para nube (/health) y robots.txt bloqueando /admin
    const health = await publicClient.request('/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.ok, true);
    assert.equal(health.data.database, 'connected');

    const robots = await publicClient.request('/robots.txt');
    assert.equal(robots.status, 200);
    assert.match(robots.data, /Disallow:\s*\/admin/i);
  });

  await t.test('2. Flujo público: configuración, disponibilidad, reserva y consulta segura', async () => {
    const cfg = await publicClient.request('/api/public/config');
    assert.equal(cfg.status, 200);
    assert.equal(cfg.data.ok, true);
    assert.ok(cfg.data.data.services.length >= 3);
    const serviceId = cfg.data.data.services[0].id;

    const availBefore = await publicClient.request(`/api/public/availability?date=${targetDate}`);
    assert.equal(availBefore.status, 200);
    assert.equal(availBefore.data.data.isOpen, true);
    const firstSlot = availBefore.data.data.slots.find((s) => s.isAvailable);
    assert.ok(firstSlot, 'Debe existir al menos un horario disponible');
    assert.equal(firstSlot.capacity, 1, 'Solo debe permitirse 1 cita por hora');
    assert.equal(availBefore.data.data.slots.length, 8, 'Horario 10:00-18:00 genera 8 bloques de 1 hora');

    const createRes = await publicClient.request('/api/public/appointments', {
      method: 'POST',
      body: {
        serviceId,
        date: targetDate,
        time: firstSlot.time,
        ownerName: 'María Elena López',
        ownerPhone: '5512345678',
        ownerEmail: 'maria@example.com',
        petName: 'Canela',
        petSpecies: 'Perro',
        petAge: '7 años',
        reasonNotes: 'Revisión anual preventiva',
      },
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.data.ok, true);
    assert.match(createRes.data.data.folio, /^FESC-\d{8}-[A-Z0-9]{4}$/);
    createdFolio = createRes.data.data.folio;

    // Al ser 1 cita por hora, el horario queda ocupado inmediatamente y rechaza una 2.ª cita (409)
    const availAfter = await publicClient.request(`/api/public/availability?date=${targetDate}`);
    const sameSlot = availAfter.data.data.slots.find((s) => s.time === firstSlot.time);
    assert.equal(sameSlot.available, 0);
    assert.equal(sameSlot.isAvailable, false);

    const duplicateHourRes = await publicClient.request('/api/public/appointments', {
      method: 'POST',
      body: {
        serviceId,
        date: targetDate,
        time: firstSlot.time,
        ownerName: 'Carlos Ramírez',
        ownerPhone: '5587654321',
        petName: 'Max',
        petSpecies: 'Perro',
      },
    });
    assert.equal(duplicateHourRes.status, 409, 'No debe permitir una segunda cita en la misma hora');

    // Consulta con teléfono erróneo debe rechazarse (privacidad)
    const badLookup = await publicClient.request(
      `/api/public/appointments/lookup?folio=${encodeURIComponent(createdFolio)}&phone=5599999999`
    );
    assert.equal(badLookup.status, 404);

    // Consulta con teléfono correcto devuelve datos sin notas internas ni ID interno, con PII enmascarada
    const goodLookup = await publicClient.request(
      `/api/public/appointments/lookup?folio=${encodeURIComponent(createdFolio)}&phone=5512345678`
    );
    assert.equal(goodLookup.status, 200);
    assert.equal(goodLookup.data.data.petName, 'Canela');
    assert.equal(goodLookup.data.data.adminNotes, undefined);
    assert.equal(goodLookup.data.data.id, undefined);
    assert.equal(goodLookup.data.data.ownerPhone, '******5678');
    assert.equal(goodLookup.data.data.ownerEmail, 'ma***@example.com');
  });

  await t.test('3. Seguridad del administrador: 401 sin sesión, 403 sin CSRF, sesión única exclusiva', async () => {
    const unauth = await adminA.request('/api/admin/appointments');
    assert.equal(unauth.status, 401);

    // Intento de login sin token CSRF -> 403
    const noCsrf = await adminA.request('/api/admin/login', {
      method: 'POST',
      body: { username: 'admin_fesc', password: 'UnamFesc#2026!' },
    });
    assert.equal(noCsrf.status, 403);

    // Obtener CSRF e intentar contraseña incorrecta -> 401
    await adminA.fetchCsrf();
    const wrongPass = await adminA.request('/api/admin/login', {
      method: 'POST',
      useCsrf: true,
      body: { username: 'admin_fesc', password: 'ClaveEquivocada1!' },
    });
    assert.equal(wrongPass.status, 401);

    // Login exitoso en Admin A
    const loginA = await adminA.request('/api/admin/login', {
      method: 'POST',
      useCsrf: true,
      body: { username: 'admin_fesc', password: 'UnamFesc#2026!' },
    });
    assert.equal(loginA.status, 200);
    adminA.csrfToken = loginA.data.data.csrfToken;

    const listA = await adminA.request(`/api/admin/appointments?date=${targetDate}`);
    assert.equal(listA.status, 200);
    assert.equal(listA.data.data.length, 1);
    assert.equal(listA.data.data[0].folio, createdFolio);
    createdAppointmentId = listA.data.data[0].id;

    // Login desde otro navegador (Admin B) DEBE invalidar la sesión de Admin A (sesión única)
    await adminB.fetchCsrf();
    const loginB = await adminB.request('/api/admin/login', {
      method: 'POST',
      useCsrf: true,
      body: { username: 'admin_fesc', password: 'UnamFesc#2026!' },
    });
    assert.equal(loginB.status, 200);
    adminB.csrfToken = loginB.data.data.csrfToken;

    const revokedA = await adminA.request('/api/admin/appointments');
    assert.equal(revokedA.status, 401, 'La sesión anterior debe invalidarse al iniciar una nueva');
  });

  await t.test('4. Sincronización bidireccional: confirmar cita, bloquear horario y cancelar', async () => {
    // Admin B confirma la cita y agrega una nota interna
    const confirmRes = await adminB.request(`/api/admin/appointments/${createdAppointmentId}`, {
      method: 'PATCH',
      useCsrf: true,
      body: { status: 'confirmada', adminNotes: 'Confirmada por llamada telefónica' },
    });
    assert.equal(confirmRes.status, 200);
    assert.equal(confirmRes.data.data.status, 'confirmada');

    // El tutor ahora ve su cita confirmada en la página pública
    const lookupConfirmed = await publicClient.request(
      `/api/public/appointments/lookup?folio=${encodeURIComponent(createdFolio)}&phone=5512345678`
    );
    assert.equal(lookupConfirmed.status, 200);
    assert.equal(lookupConfirmed.data.data.status, 'confirmada');

    // Admin B bloquea el horario 11:00 en targetDate
    const blockRes = await adminB.request('/api/admin/schedule/blocks', {
      method: 'POST',
      useCsrf: true,
      body: { blockedDate: targetDate, blockedTime: '11:00', reason: 'Junta clínica' },
    });
    assert.equal(blockRes.status, 201);
    const blockId = blockRes.data.data.id;

    // La página pública refleja inmediatamente el bloqueo de las 11:00
    const availBlocked = await publicClient.request(`/api/public/availability?date=${targetDate}`);
    const slot11 = availBlocked.data.data.slots.find((s) => s.time === '11:00');
    assert.equal(slot11.isAvailable, false);
    assert.match(slot11.reason, /Junta clínica/i);

    // Admin B elimina el bloqueo y el horario vuelve a abrirse
    const unblockRes = await adminB.request(`/api/admin/schedule/blocks/${blockId}`, {
      method: 'DELETE',
      useCsrf: true,
    });
    assert.equal(unblockRes.status, 200);

    const availUnblocked = await publicClient.request(`/api/public/availability?date=${targetDate}`);
    const slot11After = availUnblocked.data.data.slots.find((s) => s.time === '11:00');
    assert.equal(slot11After.isAvailable, true);

    // El tutor cancela su cita desde la página pública
    const cancelRes = await publicClient.request('/api/public/appointments/cancel', {
      method: 'POST',
      body: { folio: createdFolio, phone: '5512345678' },
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.data.data.status, 'cancelada');

    // Bitácora de auditoría debe registrar los eventos clave
    const auditRes = await adminB.request('/api/admin/audit-logs?limit=20');
    assert.equal(auditRes.status, 200);
    const types = auditRes.data.data.map((e) => e.eventType || e.event_type);
    assert.ok(types.includes('ADMIN_LOGIN_SUCCESS'));
    assert.ok(types.includes('ADMIN_LOGIN_FAILED'));
    assert.ok(types.includes('ADMIN_APPOINTMENT_UPDATED'));
    assert.ok(types.includes('SCHEDULE_BLOCK_ADDED'));
  });

  await t.test('5. Bloqueo temporal tras 5 intentos fallidos de inicio de sesión', async () => {
    const attacker = new TestClient(baseUrl);
    await attacker.fetchCsrf();

    for (let i = 0; i < 5; i += 1) {
      const attempt = await attacker.request('/api/admin/login', {
        method: 'POST',
        useCsrf: true,
        body: { username: 'admin_fesc', password: `IntentoMal#${i}` },
      });
      assert.ok([401, 423, 429].includes(attempt.status));
    }

    // Incluso con la contraseña correcta, la cuenta debe estar bloqueada temporalmente
    const blocked = await attacker.request('/api/admin/login', {
      method: 'POST',
      useCsrf: true,
      body: { username: 'admin_fesc', password: 'UnamFesc#2026!' },
    });
    assert.ok([423, 429].includes(blocked.status), `Se esperaba 423/429 pero llegó ${blocked.status}`);
  });

  await t.test('6. Defensa extrema anti-filtración: Fetch Metadata, HPP, Content-Type y robo de cookie', async () => {
    // Bloqueo de petición cross-site por Fetch Metadata
    const crossSite = await publicClient.request('/api/public/config', {
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(crossSite.status, 403);

    // Bloqueo de parámetros duplicados (HTTP Parameter Pollution)
    const hpp = await publicClient.request('/api/public/availability?date=2026-12-01&date=2026-12-02');
    assert.equal(hpp.status, 400);

    // Bloqueo de Prototype Pollution en cuerpo JSON
    const protoPollute = await fetch(`${baseUrl}/api/public/appointments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"__proto__":{"polluted":true}}',
    });
    assert.equal(protoPollute.status, 400);

    // Rechazo de Content-Type no JSON en escritura
    const badMime = await fetch(`${baseUrl}/api/public/appointments`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'payload-invalido',
    });
    assert.equal(badMime.status, 415);

    // Simular robo de cookie de sesión de Admin B desde otro navegador (User-Agent distinto)
    const hijackAttempt = await adminB.request('/api/admin/appointments', {
      headers: { 'User-Agent': 'AtacanteExterno/9.9' },
    });
    assert.equal(hijackAttempt.status, 401, 'Debe revocar la sesión si cambia el User-Agent');
  });
});

test('Privacidad del panel en producción: ruta secreta ADMIN_PATH y filtro opcional ADMIN_ALLOWED_IPS', async (t) => {
  const { app, db } = await createApp({
    dbPath: ':memory:',
    adminPath: '/control-fesc-9x7k',
    adminAllowedIps: ['203.0.113.10'],
    sessionSecret: 'secreto-pruebas-ruta-privada-1234567890abcdef',
    disableRateLimit: true,
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (db && typeof db.close === 'function') await db.close();
  });

  // La página pública sigue disponible normalmente
  const pubRes = await fetch(`${baseUrl}/`);
  assert.equal(pubRes.status, 200);

  // /admin y /admin.html siempre devuelven 404 cuando hay ruta privada
  assert.equal((await fetch(`${baseUrl}/admin`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/admin.html`)).status, 404);

  // Desde 127.0.0.1 (no está en adminAllowedIps), incluso la ruta secreta y /api/admin devuelven 404
  assert.equal((await fetch(`${baseUrl}/control-fesc-9x7k`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/admin/session`)).status, 404);
});
