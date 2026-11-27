/**
 * @file public/js/admin/auth.js
 * @description Módulo de autenticación, monitor de inactividad, cambio de
 * contraseña y bitácora de auditoría para el Panel de Administrador Único
 * del Hospital de Pequeñas Especies (UNAM FES Cuautitlán, Campo 4).
 *
 * Medidas de seguridad implementadas en cliente:
 * 1. Sincronización del token CSRF (`setCsrfToken`) en cada verificación o inicio de sesión.
 * 2. Manejo explícito de bloqueos anti-fuerza bruta (HTTP 423 y 429).
 * 3. Monitor de inactividad con aviso preventivo a los 2 minutos y cierre limpio al expirar.
 * 4. Recuperación segura ante respuestas HTTP 401 (expiración o inicio de sesión en otro equipo).
 * 5. Renderizado DOM seguro usando `createEl` y `textContent` (cero `innerHTML`).
 */

import {
  apiRequest,
  createEl,
  getLocalIsoDate,
  setCsrfToken,
} from '../shared/api.js';

/** Umbral de aviso previo de cierre por inactividad (2 minutos en segundos). */
const WARNING_THRESHOLD_SECONDS = 120;

/** Intervalo mínimo entre reinicios del contador por interacción de mouse/teclado (ms). */
const ACTIVITY_THROTTLE_MS = 3000;

/**
 * Mapa visual para clasificar eventos de la bitácora de auditoría con insignias legibles.
 */
const AUDIT_EVENT_STYLES = Object.freeze({
  ADMIN_LOGIN_SUCCESS: { label: 'Inicio de sesión', badgeClass: 'text-bg-success' },
  LOGIN_SUCCESS: { label: 'Inicio de sesión', badgeClass: 'text-bg-success' },
  ADMIN_LOGIN_FAILED: { label: 'Intento fallido', badgeClass: 'text-bg-danger' },
  LOGIN_FAILED: { label: 'Intento fallido', badgeClass: 'text-bg-danger' },
  ADMIN_ACCOUNT_LOCKED: { label: 'Cuenta bloqueada', badgeClass: 'text-bg-danger' },
  ADMIN_LOGIN_BLOCKED: { label: 'Acceso bloqueado', badgeClass: 'text-bg-danger' },
  ACCOUNT_LOCKED: { label: 'Cuenta bloqueada', badgeClass: 'text-bg-danger' },
  ADMIN_LOGOUT: { label: 'Cierre de sesión', badgeClass: 'text-bg-secondary' },
  LOGOUT: { label: 'Cierre de sesión', badgeClass: 'text-bg-secondary' },
  SESSION_EXPIRED: { label: 'Sesión expirada', badgeClass: 'text-bg-warning' },
  SESSION_REPLACED: { label: 'Sesión reemplazada', badgeClass: 'text-bg-warning' },
  ADMIN_PASSWORD_CHANGED: { label: 'Cambio de contraseña', badgeClass: 'text-bg-warning' },
  ADMIN_PASSWORD_CHANGE_FAILED: { label: 'Fallo cambio de clave', badgeClass: 'text-bg-danger' },
  PASSWORD_CHANGED: { label: 'Cambio de contraseña', badgeClass: 'text-bg-warning' },
  ADMIN_ACCOUNT_CONFIGURED: { label: 'Cuenta configurada', badgeClass: 'text-bg-dark' },
  ADMIN_SETUP: { label: 'Alta de administrador', badgeClass: 'text-bg-dark' },
  ADMIN_APPOINTMENT_UPDATED: { label: 'Cita actualizada', badgeClass: 'text-bg-primary' },
  APPOINTMENT_UPDATED: { label: 'Cita actualizada', badgeClass: 'text-bg-primary' },
  PUBLIC_APPOINTMENT_CANCELLED: { label: 'Cancelada por tutor', badgeClass: 'text-bg-secondary' },
  SCHEDULE_RULES_UPDATED: { label: 'Horario actualizado', badgeClass: 'text-bg-info' },
  SCHEDULE_UPDATED: { label: 'Horario actualizado', badgeClass: 'text-bg-info' },
  SCHEDULE_BLOCK_ADDED: { label: 'Bloqueo registrado', badgeClass: 'text-bg-info' },
  BLOCK_CREATED: { label: 'Bloqueo registrado', badgeClass: 'text-bg-info' },
  SCHEDULE_BLOCK_REMOVED: { label: 'Bloqueo eliminado', badgeClass: 'text-bg-secondary' },
  BLOCK_DELETED: { label: 'Bloqueo eliminado', badgeClass: 'text-bg-secondary' },
  SERVICE_UPDATED: { label: 'Servicio actualizado', badgeClass: 'text-bg-info' },
});

/**
 * Formatea una marca de tiempo ISO o SQLite ('YYYY-MM-DD HH:MM:SS') a hora local legible.
 * @param {string} rawDate
 * @returns {string}
 */
function formatTimestamp(rawDate) {
  if (!rawDate) return '—';
  // Normaliza fechas SQLite sin 'T' ni zona para evitar parseo inconsistente entre navegadores.
  const normalized =
    typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rawDate)
      ? `${rawDate.replace(' ', 'T')}Z`
      : rawDate;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return String(rawDate);
  }
  return new Intl.DateTimeFormat('es-MX', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(parsed);
}

/**
 * Resuelve el estilo visual y etiqueta humana de un tipo de evento de auditoría.
 * Soporta nombres exactos o coincidencias parciales para máxima compatibilidad.
 * @param {string} eventType
 * @returns {{ label: string, badgeClass: string }}
 */
function resolveAuditEventStyle(eventType) {
  const key = String(eventType || 'EVENTO').toUpperCase();
  if (AUDIT_EVENT_STYLES[key]) {
    return AUDIT_EVENT_STYLES[key];
  }
  if (key.includes('FAIL') || key.includes('LOCK') || key.includes('DENIED') || key.includes('ERROR')) {
    return { label: key, badgeClass: 'text-bg-danger' };
  }
  if (key.includes('LOGIN') || key.includes('SUCCESS')) {
    return { label: key, badgeClass: 'text-bg-success' };
  }
  if (key.includes('PASSWORD') || key.includes('EXPIRE') || key.includes('WARN')) {
    return { label: key, badgeClass: 'text-bg-warning' };
  }
  if (key.includes('LOGOUT') || key.includes('DELETE') || key.includes('CANCEL')) {
    return { label: key, badgeClass: 'text-bg-secondary' };
  }
  return { label: key, badgeClass: 'text-bg-primary' };
}

/**
 * Conecta un botón de mostrar/ocultar contraseña a un campo `<input>` sin HTML inline.
 * @param {HTMLButtonElement|null} button
 * @param {HTMLInputElement|null} input
 */
function bindPasswordToggle(button, input) {
  if (!button || !input) return;
  button.addEventListener('click', () => {
    const isHidden = input.type === 'password';
    input.type = isHidden ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(isHidden));

    const icon = button.querySelector('i');
    if (icon) {
      icon.className = isHidden ? 'bi bi-eye-slash' : 'bi bi-eye';
    }
  });
}

/**
 * Evalúa las reglas de robustez de la nueva contraseña en tiempo real.
 * @param {string} password
 * @param {string} confirmPassword
 */
function evaluatePasswordRules(password, confirmPassword) {
  return {
    length: password.length >= 10,
    upper: /[A-ZÁÉÍÓÚÑ]/.test(password),
    lower: /[a-záéíóúñ]/.test(password),
    number: /\d/.test(password),
    symbol: /[^A-Za-z0-9ÁÉÍÓÚáéíóúÑñ\s]/.test(password),
    match: password.length > 0 && password === confirmPassword,
  };
}

/**
 * Inicializa el módulo de autenticación, inactividad, cambio de contraseña y bitácora.
 *
 * @param {object} ctx - Dependencias compartidas inyectadas desde `app.js`.
 * @param {Function} ctx.api - Cliente HTTP con manejo centralizado de sesión 401.
 * @param {Function} ctx.showToast - Muestra notificaciones accesibles Bootstrap Toast.
 * @param {Function} ctx.onAuthenticated - Callback cuando el administrador inicia sesión.
 * @param {Function} ctx.onLoggedOut - Callback cuando se cierra o expira la sesión.
 */
export function initAuth(ctx) {
  // Referencias a vistas principales
  const viewLoading = document.getElementById('viewLoading');
  const viewSetupRequired = document.getElementById('viewSetupRequired');
  const viewLogin = document.getElementById('viewLogin');
  const viewDashboard = document.getElementById('viewDashboard');

  // Referencias de configuración y acceso
  const btnRecheckSetup = document.getElementById('btnRecheckSetup');
  const loginForm = document.getElementById('loginForm');
  const loginUsername = document.getElementById('loginUsername');
  const loginPassword = document.getElementById('loginPassword');
  const btnToggleLoginPassword = document.getElementById('btnToggleLoginPassword');
  const loginNotice = document.getElementById('loginNotice');
  const loginNoticeText = document.getElementById('loginNoticeText');
  const loginError = document.getElementById('loginError');
  const loginErrorText = document.getElementById('loginErrorText');
  const btnLoginSubmit = document.getElementById('btnLoginSubmit');
  const btnLoginSpinner = document.getElementById('btnLoginSpinner');
  const btnLoginLabel = document.getElementById('btnLoginLabel');

  // Referencias de barra superior y monitor de inactividad
  const adminUsernameDisplay = document.getElementById('adminUsernameDisplay');
  const sessionTimerBadge = document.getElementById('sessionTimerBadge');
  const sessionTimerText = document.getElementById('sessionTimerText');
  const btnLogout = document.getElementById('btnLogout');
  const inactivityWarningBanner = document.getElementById('inactivityWarningBanner');
  const inactivityWarningText = document.getElementById('inactivityWarningText');
  const btnExtendSession = document.getElementById('btnExtendSession');
  const securityTimeoutLabel = document.getElementById('securityTimeoutLabel');

  // Referencias de cambio de contraseña
  const changePasswordForm = document.getElementById('changePasswordForm');
  const currentPasswordInput = document.getElementById('currentPassword');
  const newPasswordInput = document.getElementById('newPassword');
  const confirmNewPasswordInput = document.getElementById('confirmNewPassword');
  const changePasswordError = document.getElementById('changePasswordError');
  const btnChangePasswordSubmit = document.getElementById('btnChangePasswordSubmit');
  const reqElements = {
    length: document.getElementById('reqLength'),
    upper: document.getElementById('reqUpper'),
    lower: document.getElementById('reqLower'),
    number: document.getElementById('reqNumber'),
    symbol: document.getElementById('reqSymbol'),
    match: document.getElementById('reqMatch'),
  };

  // Referencias de bitácora de auditoría
  const btnReloadAuditLogs = document.getElementById('btnReloadAuditLogs');
  const auditLogsLoading = document.getElementById('auditLogsLoading');
  const auditLogsEmpty = document.getElementById('auditLogsEmpty');
  const auditLogsTableWrap = document.getElementById('auditLogsTableWrap');
  const auditLogsBody = document.getElementById('auditLogsBody');

  // Estado interno de sesión y temporizador de inactividad
  let isAuthenticated = false;
  let timeoutMinutes = 15;
  let expiresAtMs = 0;
  let countdownIntervalId = null;
  let warningShownForCycle = false;
  let lastActivityResetMs = 0;

  /**
   * Alterna de manera exclusiva cuál de las 4 vistas raíz es visible.
   * @param {'loading'|'setup'|'login'|'dashboard'} viewName
   */
  function showView(viewName) {
    viewLoading.classList.toggle('d-none', viewName !== 'loading');
    viewSetupRequired.classList.toggle('d-none', viewName !== 'setup');
    viewLogin.classList.toggle('d-none', viewName !== 'login');
    viewDashboard.classList.toggle('d-none', viewName !== 'dashboard');
  }

  /**
   * Muestra u oculta un error en la tarjeta de login.
   * @param {string} message
   */
  function setLoginError(message) {
    if (!message) {
      loginError.classList.add('d-none');
      loginErrorText.textContent = '';
      return;
    }
    loginErrorText.textContent = message;
    loginError.classList.remove('d-none');
  }

  /**
   * Muestra u oculta un aviso informativo en la tarjeta de login (ej. sesión expirada).
   * @param {string} message
   */
  function setLoginNotice(message) {
    if (!message) {
      loginNotice.classList.add('d-none');
      loginNoticeText.textContent = '';
      return;
    }
    loginNoticeText.textContent = message;
    loginNotice.classList.remove('d-none');
  }

  /**
   * Actualiza visualmente los requisitos de contraseña del formulario de seguridad.
   */
  function updatePasswordChecklist() {
    const checks = evaluatePasswordRules(newPasswordInput.value, confirmNewPasswordInput.value);
    for (const [key, isValid] of Object.entries(checks)) {
      const item = reqElements[key];
      if (!item) continue;
      item.classList.toggle('rule-valid', isValid);
      const icon = item.querySelector('i');
      if (icon) {
        icon.className = isValid ? 'bi bi-check-circle-fill me-2' : 'bi bi-circle me-2';
      }
    }
    return checks;
  }

  /**
   * Formatea segundos restantes como 'MM:SS'.
   * @param {number} totalSeconds
   * @returns {string}
   */
  function formatCountdown(totalSeconds) {
    const safe = Math.max(0, Math.floor(totalSeconds));
    const mins = Math.floor(safe / 60);
    const secs = safe % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  /**
   * Detiene el monitor de inactividad y oculta alertas preventivas.
   */
  function stopInactivityMonitor() {
    if (countdownIntervalId !== null) {
      window.clearInterval(countdownIntervalId);
      countdownIntervalId = null;
    }
    warningShownForCycle = false;
    sessionTimerBadge.classList.remove('session-warning');
    inactivityWarningBanner.classList.add('d-none');
  }

  /**
   * Reinicia el reloj de inactividad al detectar interacción del administrador o actividad API.
   * @param {boolean} [force=false] - Si es true, omite el throttle temporal.
   */
  function markActivity(force = false) {
    if (!isAuthenticated) return;
    const now = Date.now();
    if (!force && now - lastActivityResetMs < ACTIVITY_THROTTLE_MS) {
      return;
    }
    lastActivityResetMs = now;
    expiresAtMs = now + timeoutMinutes * 60 * 1000;
    warningShownForCycle = false;
    sessionTimerBadge.classList.remove('session-warning');
    inactivityWarningBanner.classList.add('d-none');
    sessionTimerText.textContent = formatCountdown(timeoutMinutes * 60);
  }

  /**
   * Inicia el monitor de inactividad con actualización cada segundo.
   * @param {number} minutes
   */
  function startInactivityMonitor(minutes) {
    stopInactivityMonitor();
    timeoutMinutes = Math.max(1, Number(minutes) || 15);
    if (securityTimeoutLabel) {
      securityTimeoutLabel.textContent = `${timeoutMinutes} minutos`;
    }
    markActivity(true);

    countdownIntervalId = window.setInterval(() => {
      if (!isAuthenticated) {
        stopInactivityMonitor();
        return;
      }

      const remainingSeconds = Math.ceil((expiresAtMs - Date.now()) / 1000);
      sessionTimerText.textContent = formatCountdown(remainingSeconds);

      // Aviso claro cuando restan 2 minutos o menos
      if (remainingSeconds <= WARNING_THRESHOLD_SECONDS && remainingSeconds > 0) {
        sessionTimerBadge.classList.add('session-warning');
        inactivityWarningBanner.classList.remove('d-none');
        inactivityWarningText.textContent = `Tu sesión se cerrará por inactividad en ${formatCountdown(
          remainingSeconds
        )}. Pulsa "Mantener sesión activa" para continuar trabajando.`;

        if (!warningShownForCycle) {
          warningShownForCycle = true;
          ctx.showToast(
            'Quedan menos de 2 minutos de sesión por inactividad. Interactúa o extiende tu sesión.',
            'warning'
          );
        }
      }

      // Al llegar a cero, cierra la vista administrativa y regresa limpiamente al login
      if (remainingSeconds <= 0) {
        handleSessionExpired(
          'Tu sesión se cerró automáticamente por inactividad. Vuelve a iniciar sesión.'
        );
      }
    }, 1000);
  }

  /**
   * Registra los eventos del navegador que cuentan como interacción del administrador.
   */
  function bindActivityListeners() {
    const events = ['click', 'keydown', 'mousemove', 'touchstart', 'scroll'];
    for (const eventName of events) {
      window.addEventListener(
        eventName,
        () => {
          markActivity(false);
        },
        { passive: true }
      );
    }
  }

  /**
   * Maneja una expiración o revocación de sesión (HTTP 401 desde cualquier módulo o fin del reloj).
   * Regresa de forma segura a la pantalla de acceso con un mensaje comprensible.
   * @param {string} [reason]
   */
  async function handleSessionExpired(reason) {
    if (!isAuthenticated && !viewLogin.classList.contains('d-none')) {
      return;
    }

    isAuthenticated = false;
    stopInactivityMonitor();
    setCsrfToken(null);
    ctx.onLoggedOut();

    const message =
      reason ||
      'Tu sesión expiró por inactividad o porque se inició sesión desde otro dispositivo. Inicia sesión nuevamente.';

    setLoginError('');
    setLoginNotice(message);
    loginPassword.value = '';
    showView('login');

    // Solicita un nuevo token CSRF limpio para el próximo intento de acceso
    try {
      const sessionRes = await apiRequest('/api/admin/session');
      if (sessionRes.data?.csrfToken) {
        setCsrfToken(sessionRes.data.csrfToken);
      }
      if (sessionRes.data?.adminConfigured === false) {
        showView('setup');
      }
    } catch {
      // Si el servidor no responde temporalmente, el próximo login reintentará obtener CSRF.
    }
  }

  /**
   * Activa el estado autenticado tras validar sesión o completar el formulario de login.
   * @param {{ username?: string, csrfToken?: string, timeoutMinutes?: number }} sessionData
   */
  function enterAuthenticatedState(sessionData) {
    isAuthenticated = true;
    if (sessionData.csrfToken) {
      setCsrfToken(sessionData.csrfToken);
    }
    adminUsernameDisplay.textContent = sessionData.username || 'administrador';
    setLoginError('');
    setLoginNotice('');
    showView('dashboard');
    startInactivityMonitor(sessionData.timeoutMinutes || 15);
    ctx.onAuthenticated(sessionData);
  }

  /**
   * Consulta `GET /api/admin/session` al arrancar para determinar la pantalla inicial.
   */
  async function checkSession() {
    showView('loading');
    try {
      const response = await apiRequest('/api/admin/session');
      const data = response.data || {};

      // Guarda siempre el token CSRF emitido por el servidor para esta sesión
      if (data.csrfToken) {
        setCsrfToken(data.csrfToken);
      }

      if (data.adminConfigured === false) {
        isAuthenticated = false;
        stopInactivityMonitor();
        showView('setup');
        return;
      }

      if (data.authenticated) {
        enterAuthenticatedState(data);
        return;
      }

      isAuthenticated = false;
      stopInactivityMonitor();
      showView('login');
      loginUsername.focus();
    } catch (error) {
      isAuthenticated = false;
      stopInactivityMonitor();
      setLoginError(
        error.message || 'No fue posible verificar la sesión con el servidor. Intenta recargar.'
      );
      showView('login');
    }
  }

  /**
   * Procesa el envío del formulario de inicio de sesión (`POST /api/admin/login`).
   * @param {SubmitEvent} event
   */
  async function handleLoginSubmit(event) {
    event.preventDefault();
    setLoginError('');
    setLoginNotice('');

    const username = loginUsername.value.trim();
    const password = loginPassword.value;

    if (!username || !password) {
      setLoginError('Ingresa tu usuario y contraseña de administrador.');
      return;
    }

    btnLoginSubmit.disabled = true;
    btnLoginSpinner.classList.remove('d-none');
    btnLoginLabel.textContent = 'Verificando credenciales...';

    try {
      const response = await apiRequest('/api/admin/login', {
        method: 'POST',
        requiresCsrf: true,
        body: { username, password },
      });

      const data = response.data || {};
      loginPassword.value = '';
      enterAuthenticatedState(data);
      ctx.showToast('Sesión administrativa iniciada correctamente.', 'success');
    } catch (error) {
      // Mensajes claros para bloqueo temporal (423) y límite de intentos (429)
      if (error.status === 423) {
        setLoginError(
          error.message ||
            'La cuenta fue bloqueada temporalmente por múltiples intentos fallidos. Espera 15 minutos antes de volver a intentar.'
        );
      } else if (error.status === 429) {
        setLoginError(
          error.message ||
            'Demasiados intentos de acceso en poco tiempo. Espera unos minutos antes de reintentar.'
        );
      } else {
        setLoginError(error.message || 'Usuario o contraseña incorrectos.');
      }
      loginPassword.select();
    } finally {
      btnLoginSubmit.disabled = false;
      btnLoginSpinner.classList.add('d-none');
      btnLoginLabel.textContent = 'Ingresar al panel administrativo';
    }
  }

  /**
   * Cierra explícitamente la sesión del administrador (`POST /api/admin/logout`).
   */
  async function handleLogout() {
    btnLogout.disabled = true;
    try {
      await apiRequest('/api/admin/logout', {
        method: 'POST',
        requiresCsrf: true,
      });
    } catch {
      // Aunque la sesión ya hubiera expirado en el servidor, limpiamos el cliente.
    } finally {
      btnLogout.disabled = false;
      isAuthenticated = false;
      stopInactivityMonitor();
      setCsrfToken(null);
      ctx.onLoggedOut();
      loginPassword.value = '';
      setLoginError('');
      setLoginNotice('Cerraste tu sesión administrativa de forma segura.');
      showView('login');

      // Refresca el token CSRF para permitir un nuevo inicio de sesión sin recargar la página
      try {
        const res = await apiRequest('/api/admin/session');
        if (res.data?.csrfToken) {
          setCsrfToken(res.data.csrfToken);
        }
      } catch {
        // Ignorado; `apiRequest` volverá a solicitar CSRF si es necesario.
      }
    }
  }

  /**
   * Extiende la sesión tanto en cliente como en servidor haciendo una consulta protegida ligera.
   */
  async function handleExtendSession() {
    btnExtendSession.disabled = true;
    try {
      await ctx.api(`/api/admin/dashboard?date=${encodeURIComponent(getLocalIsoDate(0))}`);
      markActivity(true);
      ctx.showToast('Tu sesión activa se ha extendido correctamente.', 'success');
    } catch (error) {
      if (!error.handledAuth) {
        ctx.showToast(error.message || 'No se pudo extender la sesión.', 'danger');
      }
    } finally {
      btnExtendSession.disabled = false;
    }
  }

  /**
   * Procesa el cambio de contraseña del administrador (`POST /api/admin/change-password`).
   * @param {SubmitEvent} event
   */
  async function handleChangePasswordSubmit(event) {
    event.preventDefault();
    changePasswordError.classList.add('d-none');
    changePasswordError.textContent = '';

    const currentPassword = currentPasswordInput.value;
    const newPassword = newPasswordInput.value;
    const checks = updatePasswordChecklist();

    if (!currentPassword) {
      changePasswordError.textContent = 'Ingresa tu contraseña actual.';
      changePasswordError.classList.remove('d-none');
      return;
    }

    if (!checks.length || !checks.upper || !checks.lower || !checks.number || !checks.symbol) {
      changePasswordError.textContent =
        'La nueva contraseña debe cumplir todos los requisitos de seguridad indicados.';
      changePasswordError.classList.remove('d-none');
      return;
    }

    if (!checks.match) {
      changePasswordError.textContent = 'La confirmación de la nueva contraseña no coincide.';
      changePasswordError.classList.remove('d-none');
      return;
    }

    btnChangePasswordSubmit.disabled = true;
    try {
      const response = await ctx.api('/api/admin/change-password', {
        method: 'POST',
        requiresCsrf: true,
        body: { currentPassword, newPassword },
      });

      if (response.data?.csrfToken) {
        setCsrfToken(response.data.csrfToken);
      }

      changePasswordForm.reset();
      updatePasswordChecklist();
      ctx.showToast(
        response.message || 'Contraseña actualizada correctamente.',
        'success'
      );
      // Refresca la bitácora para reflejar el cambio de contraseña inmediatamente
      await loadAuditLogs();
    } catch (error) {
      if (!error.handledAuth) {
        changePasswordError.textContent =
          error.message || 'No fue posible actualizar la contraseña.';
        changePasswordError.classList.remove('d-none');
      }
    } finally {
      btnChangePasswordSubmit.disabled = false;
    }
  }

  /**
   * Renderiza de forma segura la tabla de bitácora de auditoría sin `innerHTML`.
   * @param {Array<object>} logs
   */
  function renderAuditLogs(logs) {
    auditLogsBody.replaceChildren();

    if (!logs.length) {
      auditLogsEmpty.classList.remove('d-none');
      auditLogsTableWrap.classList.add('d-none');
      return;
    }

    auditLogsEmpty.classList.add('d-none');
    auditLogsTableWrap.classList.remove('d-none');

    const fragment = document.createDocumentFragment();
    for (const rawLog of logs) {
      const createdAt = rawLog.createdAt ?? rawLog.created_at ?? '';
      const eventType = rawLog.eventType ?? rawLog.event_type ?? 'EVENTO';
      const actor = rawLog.actor ?? 'sistema';
      const ipAddress = rawLog.ipAddress ?? rawLog.ip_address ?? '—';
      const details = rawLog.details ?? '';

      const eventStyle = resolveAuditEventStyle(eventType);

      const row = createEl('tr', {}, [
        createEl('td', {
          className: 'text-nowrap small text-muted',
          text: formatTimestamp(createdAt),
        }),
        createEl('td', { className: 'text-nowrap' }, [
          createEl('span', {
            className: `badge ${eventStyle.badgeClass}`,
            text: eventStyle.label,
            title: String(eventType),
          }),
        ]),
        createEl('td', {
          className: 'small fw-semibold text-nowrap',
          text: String(actor || 'sistema'),
        }),
        createEl('td', {
          className: 'small font-monospace text-muted text-nowrap',
          text: String(ipAddress || '—'),
        }),
        createEl('td', {
          className: 'small',
          text: String(details || '—'),
        }),
      ]);

      fragment.appendChild(row);
    }

    auditLogsBody.appendChild(fragment);
  }

  /**
   * Consulta los últimos 50 eventos de seguridad (`GET /api/admin/audit-logs?limit=50`).
   */
  async function loadAuditLogs() {
    if (!isAuthenticated) return;

    auditLogsLoading.classList.remove('d-none');
    auditLogsEmpty.classList.add('d-none');
    auditLogsTableWrap.classList.add('d-none');
    btnReloadAuditLogs.disabled = true;

    try {
      const response = await ctx.api('/api/admin/audit-logs?limit=50');
      const rawData = response.data;
      const logs = Array.isArray(rawData)
        ? rawData
        : Array.isArray(rawData?.logs)
          ? rawData.logs
          : Array.isArray(rawData?.auditLogs)
            ? rawData.auditLogs
            : [];
      renderAuditLogs(logs);
    } catch (error) {
      if (!error.handledAuth) {
        ctx.showToast(error.message || 'No se pudo cargar la bitácora de auditoría.', 'danger');
        auditLogsEmpty.classList.remove('d-none');
      }
    } finally {
      auditLogsLoading.classList.add('d-none');
      btnReloadAuditLogs.disabled = false;
    }
  }

  // Enlace de controles de visibilidad de contraseñas
  bindPasswordToggle(btnToggleLoginPassword, loginPassword);
  bindPasswordToggle(document.getElementById('btnToggleCurrentPassword'), currentPasswordInput);
  bindPasswordToggle(document.getElementById('btnToggleNewPassword'), newPasswordInput);
  bindPasswordToggle(
    document.getElementById('btnToggleConfirmPassword'),
    confirmNewPasswordInput
  );

  // Enlace de eventos de formularios y botones
  btnRecheckSetup.addEventListener('click', () => {
    checkSession();
  });
  loginForm.addEventListener('submit', handleLoginSubmit);
  btnLogout.addEventListener('click', handleLogout);
  btnExtendSession.addEventListener('click', handleExtendSession);

  newPasswordInput.addEventListener('input', updatePasswordChecklist);
  confirmNewPasswordInput.addEventListener('input', updatePasswordChecklist);
  changePasswordForm.addEventListener('submit', handleChangePasswordSubmit);
  btnReloadAuditLogs.addEventListener('click', () => {
    loadAuditLogs();
  });

  bindActivityListeners();
  updatePasswordChecklist();

  return {
    checkSession,
    markActivity,
    handleSessionExpired,
    loadAuditLogs,
    isAuthenticated: () => isAuthenticated,
  };
}
