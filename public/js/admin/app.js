/**
 * @file public/js/admin/app.js
 * @description Orquestador principal del Panel de Administrador Único (`/admin`)
 * del Hospital de Pequeñas Especies — UNAM FES Cuautitlán (Campo 4).
 *
 * Responsabilidades:
 * 1. Proveer notificaciones accesibles con Bootstrap Toasts (`showToast`) sin `innerHTML`.
 * 2. Proveer un modal accesible de confirmación (`confirmAction`) para acciones críticas.
 * 3. Envolver `apiRequest` para reiniciar el contador de inactividad y capturar
 *    automáticamente errores HTTP 401 (sesión expirada o reemplazada en otro equipo).
 * 4. Coordinar la carga y sincronización entre las 3 pestañas:
 *    - Agenda y Citas (`appointments.js`)
 *    - Horarios, Bloqueos y Servicios (`schedule.js`)
 *    - Seguridad y Bitácora (`auth.js`)
 */

import { apiRequest, createEl } from '../shared/api.js';
import { initAppointments } from './appointments.js';
import { initAuth } from './auth.js';
import { initSchedule } from './schedule.js';

/**
 * Iconos y clases Bootstrap asociadas a cada tipo de notificación Toast.
 */
const TOAST_VARIANTS = Object.freeze({
  success: { bgClass: 'text-bg-success', icon: 'bi-check-circle-fill', closeWhite: true },
  danger: { bgClass: 'text-bg-danger', icon: 'bi-exclamation-octagon-fill', closeWhite: true },
  warning: { bgClass: 'text-bg-warning', icon: 'bi-exclamation-triangle-fill', closeWhite: false },
  info: { bgClass: 'text-bg-primary', icon: 'bi-info-circle-fill', closeWhite: true },
});

/**
 * Muestra una notificación accesible usando Bootstrap Toast y nodos DOM seguros.
 * @param {string} message - Texto visible para el administrador.
 * @param {'success'|'danger'|'warning'|'info'} [variant='success']
 */
function showToast(message, variant = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const meta = TOAST_VARIANTS[variant] || TOAST_VARIANTS.info;

  const toastEl = createEl(
    'div',
    {
      className: `toast align-items-center border-0 ${meta.bgClass}`,
      role: variant === 'danger' ? 'alert' : 'status',
      'aria-live': variant === 'danger' ? 'assertive' : 'polite',
      'aria-atomic': 'true',
    },
    [
      createEl('div', { className: 'd-flex' }, [
        createEl('div', { className: 'toast-body d-flex align-items-center gap-2' }, [
          createEl('i', { className: `bi ${meta.icon} flex-shrink-0`, 'aria-hidden': 'true' }),
          createEl('span', { text: String(message) }),
        ]),
        createEl('button', {
          type: 'button',
          className: `btn-close me-2 m-auto ${meta.closeWhite ? 'btn-close-white' : ''}`,
          'data-bs-dismiss': 'toast',
          'aria-label': 'Cerrar notificación',
        }),
      ]),
    ]
  );

  container.appendChild(toastEl);
  const toastInstance = new window.bootstrap.Toast(toastEl, { delay: 4800 });
  toastEl.addEventListener('hidden.bs.toast', () => {
    toastEl.remove();
  });
  toastInstance.show();
}

/**
 * Crea el controlador del modal reutilizable de confirmación para acciones sensibles
 * (cancelar cita, eliminar bloqueo, etc.).
 */
function createConfirmController() {
  const modalEl = document.getElementById('confirmActionModal');
  const titleEl = document.getElementById('confirmModalTitle');
  const messageEl = document.getElementById('confirmModalMessage');
  const acceptBtn = document.getElementById('btnConfirmModalAccept');
  const bsModal = new window.bootstrap.Modal(modalEl);

  let pendingResolver = null;

  acceptBtn.addEventListener('click', () => {
    if (pendingResolver) {
      const resolve = pendingResolver;
      pendingResolver = null;
      bsModal.hide();
      resolve(true);
    }
  });

  modalEl.addEventListener('hidden.bs.modal', () => {
    if (pendingResolver) {
      const resolve = pendingResolver;
      pendingResolver = null;
      resolve(false);
    }
  });

  /**
   * Muestra el modal y resuelve `true` si el administrador confirmó la acción.
   * @param {{ title?: string, message: string, confirmLabel?: string, confirmVariant?: string }} options
   * @returns {Promise<boolean>}
   */
  function confirmAction({
    title = 'Confirmar acción',
    message,
    confirmLabel = 'Confirmar',
    confirmVariant = 'danger',
  }) {
    titleEl.textContent = title;
    messageEl.textContent = message;
    acceptBtn.textContent = confirmLabel;
    acceptBtn.className = `btn btn-sm btn-${confirmVariant}`;

    return new Promise((resolve) => {
      pendingResolver = resolve;
      bsModal.show();
    });
  }

  return {
    confirmAction,
    hide: () => bsModal.hide(),
  };
}

/**
 * Punto de entrada al cargar el DOM de `/admin`.
 */
function bootstrapAdminPanel() {
  const confirmCtrl = createConfirmController();

  // Referencias tardías para conectar módulos sin dependencias circulares
  let authCtrl = null;
  let appointmentsCtrl = null;
  let scheduleCtrl = null;

  /**
   * Cliente API protegido compartido por todas las pestañas administrativas.
   * - Reinicia el reloj de inactividad ante cada llamada exitosa.
   * - Si el servidor responde HTTP 401, redirige limpiamente al login con aviso claro.
   *
   * @param {string} url
   * @param {object} [options]
   */
  async function adminApi(url, options = {}) {
    try {
      const result = await apiRequest(url, options);
      if (authCtrl) {
        authCtrl.markActivity(true);
      }
      return result;
    } catch (error) {
      if (error.status === 401 && authCtrl) {
        error.handledAuth = true;
        await authCtrl.handleSessionExpired(
          error.message ||
            'Tu sesión expiró por inactividad o porque se inició sesión en otro dispositivo.'
        );
      }
      throw error;
    }
  }

  const sharedContext = {
    api: adminApi,
    showToast,
    confirmAction: confirmCtrl.confirmAction,
    onAuthenticated: () => {
      // Restablece a la pestaña principal (Agenda y Citas) y carga datos iniciales
      const agendaTabBtn = document.getElementById('tabBtnAgenda');
      if (agendaTabBtn) {
        window.bootstrap.Tab.getOrCreateInstance(agendaTabBtn).show();
      }
      if (appointmentsCtrl) {
        appointmentsCtrl.refresh();
      }
    },
    onLoggedOut: () => {
      // Cierra cualquier modal abierto si la sesión se cerró o expiró en medio de una edición
      confirmCtrl.hide();
      if (appointmentsCtrl) {
        appointmentsCtrl.closeModals();
      }
    },
  };

  // Inicializa los tres módulos del panel
  authCtrl = initAuth(sharedContext);
  appointmentsCtrl = initAppointments(sharedContext);
  scheduleCtrl = initSchedule(sharedContext);

  // Refresca cada pestaña automáticamente al navegar hacia ella
  const tabBtnAgenda = document.getElementById('tabBtnAgenda');
  const tabBtnHorarios = document.getElementById('tabBtnHorarios');
  const tabBtnSeguridad = document.getElementById('tabBtnSeguridad');

  tabBtnAgenda.addEventListener('shown.bs.tab', () => {
    if (authCtrl.isAuthenticated()) {
      appointmentsCtrl.refresh();
    }
  });

  tabBtnHorarios.addEventListener('shown.bs.tab', () => {
    if (authCtrl.isAuthenticated()) {
      scheduleCtrl.refresh();
    }
  });

  tabBtnSeguridad.addEventListener('shown.bs.tab', () => {
    if (authCtrl.isAuthenticated()) {
      authCtrl.loadAuditLogs();
    }
  });

  // Arranque: verifica si existe cuenta configurada y si hay sesión administrativa activa
  authCtrl.checkSession();
}

document.addEventListener('DOMContentLoaded', bootstrapAdminPanel);
