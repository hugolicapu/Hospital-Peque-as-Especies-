/**
 * @file public/js/shared/api.js
 * @description Cliente HTTP compartido para ambas páginas web (Citas Públicas y
 * Panel de Administrador), además de utilidades seguras de formato y DOM.
 *
 * Responsabilidades:
 * 1. Centralizar peticiones `fetch` con `credentials: 'same-origin'` (cookies de sesión).
 * 2. Adjuntar automáticamente el token `X-CSRF-Token` en peticiones modificadoras del administrador.
 * 3. Proveer helpers de formato de fechas/horas pensados para lectura clara en español.
 * 4. Proveer creación segura de nodos DOM (`createEl`) evitando riesgos de XSS por `innerHTML`.
 */

let cachedCsrfToken = null;

/**
 * Actualiza el token CSRF guardado en memoria (por ejemplo tras iniciar sesión).
 * @param {string|null} token
 */
export function setCsrfToken(token) {
  cachedCsrfToken = token || null;
}

/**
 * Obtiene el token CSRF vigente desde el servidor o desde la caché en memoria.
 * @param {boolean} [forceRefresh=false] - Si es true, solicita un token fresco al servidor.
 * @returns {Promise<string>}
 */
export async function getCsrfToken(forceRefresh = false) {
  if (cachedCsrfToken && !forceRefresh) {
    return cachedCsrfToken;
  }

  const response = await fetch('/api/admin/csrf-token', {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok || !payload.data?.csrfToken) {
    throw new Error(payload.error || 'No se pudo obtener el token de seguridad.');
  }

  cachedCsrfToken = payload.data.csrfToken;
  return cachedCsrfToken;
}

/**
 * Ejecuta una petición JSON contra el backend del hospital.
 * Maneja errores de red, respuestas con error y cabeceras CSRF automáticamente.
 *
 * @param {string} url - Ruta relativa del endpoint (ej. '/api/public/config').
 * @param {object} [options]
 * @param {string} [options.method='GET']
 * @param {object} [options.body]
 * @param {boolean} [options.requiresCsrf=false]
 * @returns {Promise<{ok: boolean, message?: string, data: any}>}
 */
export async function apiRequest(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = {
    Accept: 'application/json',
  };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  // Las acciones que modifican datos en el panel administrador SIEMPRE llevan token CSRF.
  const isAdminMutation =
    options.requiresCsrf ||
    (url.startsWith('/api/admin/') && !['GET', 'HEAD', 'OPTIONS'].includes(method));

  if (isAdminMutation) {
    headers['X-CSRF-Token'] = await getCsrfToken();
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    const err = new Error('No fue posible conectar con el servidor. Verifica que el sistema esté encendido.');
    err.status = 0;
    throw err;
  }

  const payload = await response.json().catch(() => ({
    ok: false,
    error: 'Respuesta inesperada del servidor.',
  }));

  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || 'Ocurrió un problema al procesar la solicitud.');
    error.status = response.status;
    error.details = payload.details || [];
    throw error;
  }

  return payload;
}

/**
 * Convierte una fecha ISO ('YYYY-MM-DD') a formato legible en español de México.
 * Ejemplo: '2026-11-27' -> 'viernes, 27 de noviembre de 2026'
 * @param {string} isoDate
 * @returns {string}
 */
export function formatDateSpanish(isoDate) {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate || '';
  const [year, month, day] = isoDate.split('-').map(Number);
  const dateObj = new Date(year, month - 1, day);
  return new Intl.DateTimeFormat('es-MX', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(dateObj);
}

/**
 * Convierte hora de 24h ('14:30') a formato 12h legible ('2:30 p. m.').
 * @param {string} time24
 * @returns {string}
 */
export function formatTime12h(time24) {
  if (!time24 || !/^\d{2}:\d{2}$/.test(time24)) return time24 || '';
  const [hours, minutes] = time24.split(':').map(Number);
  const period = hours >= 12 ? 'p. m.' : 'a. m.';
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${h12}:${String(minutes).padStart(2, '0')} ${period}`;
}

/**
 * Obtiene la fecha actual local en formato 'YYYY-MM-DD'.
 * @param {number} [offsetDays=0] - Días a sumar o restar desde hoy.
 * @returns {string}
 */
export function getLocalIsoDate(offsetDays = 0) {
  const now = new Date();
  now.setDate(now.getDate() + offsetDays);
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Crea un elemento DOM de forma segura (sin `innerHTML`), previniendo inyección XSS.
 * @param {string} tag
 * @param {Record<string, any>} [attrs={}]
 * @param {Array<Node|string|null|undefined>} [children=[]]
 * @returns {HTMLElement}
 */
export function createEl(tag, attrs = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'className') {
      element.className = String(value);
    } else if (key === 'text') {
      element.textContent = String(value);
    } else if (key === 'dataset' && typeof value === 'object') {
      for (const [dKey, dVal] of Object.entries(value)) {
        element.dataset[dKey] = String(dVal);
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      element.setAttribute(key, '');
    } else {
      element.setAttribute(key, String(value));
    }
  }

  for (const child of children) {
    if (child === null || child === undefined) continue;
    if (typeof child === 'string' || typeof child === 'number') {
      element.appendChild(document.createTextNode(String(child)));
    } else {
      element.appendChild(child);
    }
  }
  return element;
}

/**
 * Diccionario de etiquetas y colores Bootstrap por estado de cita.
 */
export const STATUS_META = Object.freeze({
  pendiente: { label: 'Pendiente por confirmar', shortLabel: 'Pendiente', badgeClass: 'text-bg-warning' },
  confirmada: { label: 'Confirmada', shortLabel: 'Confirmada', badgeClass: 'text-bg-success' },
  atendida: { label: 'Atendida', shortLabel: 'Atendida', badgeClass: 'text-bg-primary' },
  cancelada: { label: 'Cancelada', shortLabel: 'Cancelada', badgeClass: 'text-bg-secondary' },
});
