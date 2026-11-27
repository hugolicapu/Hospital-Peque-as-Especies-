/**
 * @file public/js/citas/app.js
 * @description Punto de entrada principal de la Página Pública de Citas del
 * Hospital de Pequeñas Especies UNAM FES Cuautitlán (Campo 4).
 *
 * Responsabilidades:
 * 1. Restaurar y controlar la barra superior de accesibilidad (A-, A+, A++ y Alto Contraste)
 *    guardando la preferencia del usuario en `localStorage`.
 * 2. Cargar la configuración pública del hospital (`GET /api/public/config`) y
 *    actualizar encabezado, dirección, teléfono y horarios habituales.
 * 3. Gestionar el selector de dos pestañas principales:
 *    - "Agendar una cita nueva" (`wizard.js`)
 *    - "Consultar o cancelar mi cita" (`lookup.js`)
 */

import { apiRequest, formatTime12h } from '../shared/api.js';
import { initWizard } from './wizard.js';
import { initLookup } from './lookup.js';

const STORAGE_KEYS = Object.freeze({
  fontSize: 'hpe_fesc_font_size',
  highContrast: 'hpe_fesc_high_contrast',
});

const DAY_NAMES_SHORT = Object.freeze([
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
]);

/**
 * Envía un mensaje corto a la región `aria-live` para usuarios con lector de pantalla.
 * @param {string} message
 */
export function announceForScreenReader(message) {
  const announcer = document.getElementById('sr-announcer');
  if (!announcer) return;
  announcer.textContent = '';
  window.setTimeout(() => {
    announcer.textContent = message;
  }, 40);
}

/**
 * Aplica el tamaño de letra elegido (`normal`, `large` o `xlarge`) sobre `<html>`
 * y actualiza el estado visual/ARIA de los botones `A-`, `A+`, `A++`.
 * @param {'normal'|'large'|'xlarge'} size
 */
function applyFontSize(size) {
  const validSize = ['normal', 'large', 'xlarge'].includes(size) ? size : 'normal';
  const root = document.documentElement;

  root.classList.remove('font-lg', 'font-xl');
  if (validSize === 'large') root.classList.add('font-lg');
  if (validSize === 'xlarge') root.classList.add('font-xl');

  document.querySelectorAll('[data-font-size]').forEach((btn) => {
    const isSelected = btn.getAttribute('data-font-size') === validSize;
    btn.setAttribute('aria-pressed', String(isSelected));
  });

  try {
    window.localStorage.setItem(STORAGE_KEYS.fontSize, validSize);
  } catch {
    // Si el navegador bloquea localStorage (modo privado estricto), continuamos sin error.
  }
}

/**
 * Activa o desactiva el modo de alto contraste sobre `<html>`.
 * @param {boolean} enabled
 */
function applyHighContrast(enabled) {
  const isEnabled = Boolean(enabled);
  document.documentElement.classList.toggle('high-contrast', isEnabled);

  const contrastBtn = document.getElementById('btn-high-contrast');
  if (contrastBtn) {
    contrastBtn.setAttribute('aria-pressed', String(isEnabled));
  }

  try {
    window.localStorage.setItem(STORAGE_KEYS.highContrast, isEnabled ? '1' : '0');
  } catch {
    // Ignorar si el almacenamiento local no está disponible.
  }
}

/**
 * Restaura inmediatamente las preferencias visuales guardadas en `localStorage`
 * (se ejecuta al cargar el módulo para evitar parpadeos visuales).
 */
function restoreAccessibilityPreferences() {
  let savedFont = 'normal';
  let savedContrast = false;

  try {
    savedFont = window.localStorage.getItem(STORAGE_KEYS.fontSize) || 'normal';
    savedContrast = window.localStorage.getItem(STORAGE_KEYS.highContrast) === '1';
  } catch {
    // Usar valores por defecto.
  }

  applyFontSize(savedFont);
  applyHighContrast(savedContrast);
}

/**
 * Conecta los eventos de clic de la barra superior de accesibilidad una sola vez.
 */
function initAccessibilityToolbar() {
  restoreAccessibilityPreferences();

  document.querySelectorAll('[data-font-size]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const size = btn.getAttribute('data-font-size') || 'normal';
      applyFontSize(size);

      const labels = {
        normal: 'Tamaño de letra cambiado a normal.',
        large: 'Tamaño de letra cambiado a grande.',
        xlarge: 'Tamaño de letra cambiado a muy grande.',
      };
      announceForScreenReader(labels[size] || labels.normal);
    });
  });

  const contrastBtn = document.getElementById('btn-high-contrast');
  if (contrastBtn) {
    contrastBtn.addEventListener('click', () => {
      const nextState = !document.documentElement.classList.contains('high-contrast');
      applyHighContrast(nextState);
      announceForScreenReader(
        nextState ? 'Modo de alto contraste activado.' : 'Modo de alto contraste desactivado.'
      );
    });
  }
}

/**
 * Configura el cambio entre las dos pestañas principales:
 * "Agendar una cita nueva" y "Consultar o cancelar mi cita".
 */
function initMainTabs() {
  const tabBook = document.getElementById('tab-book');
  const tabLookup = document.getElementById('tab-lookup');
  const panelBook = document.getElementById('panel-book');
  const panelLookup = document.getElementById('panel-lookup');

  if (!tabBook || !tabLookup || !panelBook || !panelLookup) return;

  function activateTab(mode) {
    const isBook = mode === 'book';

    tabBook.classList.toggle('active', isBook);
    tabBook.setAttribute('aria-selected', String(isBook));
    panelBook.classList.toggle('d-none', !isBook);

    tabLookup.classList.toggle('active', !isBook);
    tabLookup.setAttribute('aria-selected', String(!isBook));
    panelLookup.classList.toggle('d-none', isBook);

    if (isBook) {
      announceForScreenReader('Sección activa: Agendar una cita nueva.');
    } else {
      announceForScreenReader('Sección activa: Consultar o cancelar mi cita.');
      const folioInput = document.getElementById('lookup-folio');
      if (folioInput) folioInput.focus();
    }
  }

  tabBook.addEventListener('click', () => activateTab('book'));
  tabLookup.addEventListener('click', () => activateTab('lookup'));
}

/**
 * Genera un resumen legible del horario habitual del hospital a partir de las
 * reglas semanales recibidas en `/api/public/config`.
 * @param {Array<object>} scheduleRules
 * @returns {string}
 */
function buildHoursSummary(scheduleRules) {
  if (!Array.isArray(scheduleRules) || scheduleRules.length === 0) return '';

  const openRules = scheduleRules
    .filter((rule) => Boolean(rule.isOpen ?? rule.is_open))
    .sort((a, b) => Number(a.dayOfWeek ?? a.day_of_week) - Number(b.dayOfWeek ?? b.day_of_week));

  if (openRules.length === 0) {
    return 'Consulte disponibilidad de horarios en el calendario.';
  }

  const first = openRules[0];
  const last = openRules[openRules.length - 1];
  const startTime = formatTime12h(first.startTime ?? first.start_time ?? '10:00');
  const endTime = formatTime12h(first.endTime ?? first.end_time ?? '18:00');

  const firstDay = DAY_NAMES_SHORT[Number(first.dayOfWeek ?? first.day_of_week)] || '';
  const lastDay = DAY_NAMES_SHORT[Number(last.dayOfWeek ?? last.day_of_week)] || '';

  // Si hay varios días abiertos consecutivos (por ejemplo lunes a viernes), lo resumimos.
  const isContiguous = openRules.every((rule, index) => {
    if (index === 0) return true;
    const prevDay = Number(openRules[index - 1].dayOfWeek ?? openRules[index - 1].day_of_week);
    const currDay = Number(rule.dayOfWeek ?? rule.day_of_week);
    return currDay === prevDay + 1;
  });

  if (isContiguous && openRules.length > 1) {
    return `Horario habitual: de ${firstDay} a ${lastDay}, ${startTime} a ${endTime}`;
  }

  const dayList = openRules
    .map((rule) => DAY_NAMES_SHORT[Number(rule.dayOfWeek ?? rule.day_of_week)])
    .filter(Boolean)
    .join(', ');

  return `Días de atención: ${dayList} (${startTime} a ${endTime})`;
}

/**
 * Pinta los datos institucionales del hospital (nombre, dirección, teléfono y
 * horario habitual) en el encabezado y pie de página usando `textContent`.
 * @param {object} configData
 */
function renderHospitalHeader(configData) {
  const hospital = configData?.hospital || {};

  const nameEl = document.getElementById('hospital-name');
  const instEl = document.getElementById('hospital-institution');
  const phoneEl = document.getElementById('hospital-phone');
  const phoneLinkEl = document.getElementById('hospital-phone-link');
  const addressEl = document.getElementById('hospital-address');
  const footerAddressEl = document.getElementById('footer-address');
  const hoursRowEl = document.getElementById('hospital-hours-row');
  const hoursSummaryEl = document.getElementById('hospital-hours-summary');

  if (nameEl && hospital.name) {
    nameEl.textContent = hospital.name;
  }

  if (instEl && hospital.institution) {
    instEl.textContent = hospital.institution;
  }

  if (phoneEl && hospital.phone) {
    phoneEl.textContent = hospital.phone;
    if (phoneLinkEl) {
      const dialNumber =
        hospital.phoneDial || String(hospital.phone).replace(/\D/g, '').slice(0, 10);
      phoneLinkEl.setAttribute('href', `tel:${dialNumber || hospital.phone}`);
    }
  }

  if (addressEl && hospital.address) {
    addressEl.textContent = hospital.address;
  }

  if (footerAddressEl && hospital.address) {
    footerAddressEl.textContent = hospital.address;
  }

  const hoursText = buildHoursSummary(configData?.schedule);
  if (hoursRowEl && hoursSummaryEl && hoursText) {
    hoursSummaryEl.textContent = hoursText;
    hoursRowEl.classList.remove('d-none');
  }
}

/**
 * Carga la configuración inicial desde `/api/public/config` y arranca los
 * módulos de asistente de citas (`wizard.js`) y consulta (`lookup.js`).
 */
async function bootstrapPublicApp() {
  initAccessibilityToolbar();
  initMainTabs();

  // Inicializamos el módulo de consulta/cancelación de inmediato para que funcione
  // incluso mientras carga la configuración inicial del asistente.
  let hospitalConfig = null;
  initLookup(() => hospitalConfig);

  const wizardController = initWizard({
    announce: announceForScreenReader,
    onRetryConfig: loadConfig,
  });

  async function loadConfig() {
    wizardController.setConfigLoading(true);
    try {
      const response = await apiRequest('/api/public/config');
      hospitalConfig = response.data || {};
      renderHospitalHeader(hospitalConfig);
      wizardController.setConfig(hospitalConfig);
    } catch (error) {
      wizardController.setConfigError(
        error.message ||
          'No pudimos cargar los servicios del hospital en este momento. Intente de nuevo.'
      );
    }
  }

  await loadConfig();
}

// Aplicamos inmediatamente preferencias guardadas antes del pintado completo para evitar parpadeos.
restoreAccessibilityPreferences();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrapPublicApp, { once: true });
} else {
  bootstrapPublicApp();
}
