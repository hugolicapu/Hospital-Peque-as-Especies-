/**
 * @file public/js/citas/lookup.js
 * @description Módulo para la sección "Consultar o cancelar mi cita" de la
 * Página Pública de Citas del Hospital de Pequeñas Especies UNAM FES Cuautitlán.
 *
 * Responsabilidades:
 * 1. Validar folio y teléfono de 10 dígitos con mensajes claros en español.
 * 2. Consultar `GET /api/public/appointments/lookup?folio=...&phone=...` y
 *    mostrar el estado y detalles actuales de la cita de forma segura (sin `innerHTML`).
 * 3. Permitir cancelar citas en estado `pendiente` o `confirmada` mediante un
 *    modal de confirmación Bootstrap que evita clics accidentales.
 */

import {
  apiRequest,
  createEl,
  formatDateSpanish,
  formatTime12h,
  STATUS_META,
} from '../shared/api.js';
import { populateOfficialReceipt, printOfficialReceipt } from './receipt.js';

/**
 * Extrae únicamente los dígitos de un número telefónico.
 * @param {string} value
 * @returns {string}
 */
function extractDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

/**
 * Crea una fila de resumen legible (`etiqueta -> dato`).
 * @param {string} label
 * @param {string} value
 * @returns {HTMLElement}
 */
function createDetailRow(label, value) {
  return createEl('div', { className: 'summary-row' }, [
    createEl('div', { className: 'summary-key', text: label }),
    createEl('div', { className: 'summary-value', text: value }),
  ]);
}

/**
 * Inicializa el formulario de consulta y el flujo de cancelación con modal.
 * @param {() => object|null} getHospitalConfig - Callback para leer datos del hospital si ya cargaron.
 */
export function initLookup(getHospitalConfig) {
  const form = document.getElementById('lookup-form');
  const folioInput = document.getElementById('lookup-folio');
  const phoneInput = document.getElementById('lookup-phone');
  const submitBtn = document.getElementById('btn-lookup-submit');
  const alertEl = document.getElementById('lookup-alert');
  const resultContainer = document.getElementById('lookup-result');

  // Referencias del modal de confirmación para cancelar
  const cancelModalEl = document.getElementById('cancelAppointmentModal');
  const cancelModalSummary = document.getElementById('cancel-modal-summary');
  const cancelModalError = document.getElementById('cancel-modal-error');
  const btnConfirmCancel = document.getElementById('btn-cancel-modal-confirm');

  if (!form || !folioInput || !phoneInput || !resultContainer) return;

  // Estado local de la última cita encontrada
  const state = {
    folio: '',
    phone: '',
    appointment: null,
    cancelling: false,
  };

  /**
   * Muestra u oculta una alerta en el panel de consulta.
   * @param {string} message
   * @param {'danger'|'warning'|'success'} [type='danger']
   */
  function showLookupAlert(message, type = 'danger') {
    if (!alertEl) return;
    if (!message) {
      alertEl.classList.add('d-none');
      alertEl.replaceChildren();
      return;
    }

    alertEl.className = `alert-box alert-box-${type} mb-4`;
    const iconClass =
      type === 'success'
        ? 'bi-check-circle-fill'
        : type === 'warning'
          ? 'bi-exclamation-triangle-fill'
          : 'bi-exclamation-circle-fill';

    alertEl.replaceChildren(
      createEl('div', { className: 'd-flex align-items-start gap-2' }, [
        createEl('i', { className: `bi ${iconClass} mt-1`, 'aria-hidden': 'true' }),
        createEl('span', { text: message }),
      ])
    );
  }

  /**
   * Muestra u oculta un error específico de campo del formulario de búsqueda.
   * @param {string} errorId
   * @param {HTMLElement} inputEl
   * @param {string} message
   */
  function setFieldError(errorId, inputEl, message) {
    const errorEl = document.getElementById(errorId);
    if (errorEl) {
      if (message) {
        errorEl.textContent = message;
        errorEl.classList.remove('d-none');
      } else {
        errorEl.textContent = '';
        errorEl.classList.add('d-none');
      }
    }

    inputEl.classList.toggle('is-invalid', Boolean(message));
    inputEl.setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  /**
   * Abre el modal Bootstrap de confirmación mostrando los datos clave de la cita.
   */
  function openCancelModal() {
    if (!state.appointment || !cancelModalEl) return;

    const appt = state.appointment;
    const folio = appt.folio || state.folio;
    const dateVal = appt.date || appt.appointment_date || '';
    const timeVal = appt.time || appt.appointment_time || '';
    const petName = appt.petName || appt.pet_name || '';

    if (cancelModalError) {
      cancelModalError.classList.add('d-none');
      cancelModalError.replaceChildren();
    }

    if (cancelModalSummary) {
      cancelModalSummary.replaceChildren(
        createEl('p', { className: 'mb-1' }, [
          createEl('strong', { text: 'Folio: ' }),
          folio,
        ]),
        createEl('p', { className: 'mb-1' }, [
          createEl('strong', { text: 'Mascota: ' }),
          petName,
        ]),
        createEl('p', { className: 'mb-0' }, [
          createEl('strong', { text: 'Día y hora: ' }),
          `${formatDateSpanish(dateVal)} a las ${formatTime12h(timeVal)}`,
        ])
      );
    }

    if (window.bootstrap?.Modal) {
      const modalInstance = window.bootstrap.Modal.getOrCreateInstance(cancelModalEl);
      modalInstance.show();
    }
  }

  /**
   * Dibuja la tarjeta con la información completa de la cita consultada y,
   * si aplica (`pendiente` o `confirmada`), el botón grande para cancelarla.
   * @param {object} appt
   */
  function renderAppointmentResult(appt) {
    const folio = appt.folio || state.folio;
    const serviceName = appt.serviceName || appt.service_name || 'Consulta veterinaria';
    const dateVal = appt.date || appt.appointment_date || '';
    const timeVal = appt.time || appt.appointment_time || '';
    const ownerName = appt.ownerName || appt.owner_name || '';
    const ownerPhone = appt.ownerPhone || appt.owner_phone || state.phone;
    const petName = appt.petName || appt.pet_name || '';
    const petSpecies = appt.petSpecies || appt.pet_species || '';
    const petAge = appt.petAge || appt.pet_age || '';
    const reasonNotes = appt.reasonNotes || appt.reason_notes || '';
    const statusKey = appt.status || 'pendiente';
    const statusMeta = STATUS_META[statusKey] || {
      label: statusKey,
      badgeClass: 'text-bg-secondary',
    };

    const canCancel = statusKey === 'pendiente' || statusKey === 'confirmada';

    const header = createEl('div', { className: 'lookup-status-header' }, [
      createEl('div', {}, [
        createEl('span', { className: 'summary-key d-block', text: 'Folio de la cita' }),
        createEl('strong', { className: 'fs-4 text-unam-blue', text: folio }),
      ]),
      createEl('span', {
        className: `badge status-pill ${statusMeta.badgeClass}`,
        text: statusMeta.label,
      }),
    ]);

    const rows = [
      createDetailRow('Servicio', serviceName),
      createDetailRow('Día de la cita', formatDateSpanish(dateVal)),
      createDetailRow('Hora de la cita', formatTime12h(timeVal)),
      createDetailRow('Dueño o tutor', ownerName),
      createDetailRow('Teléfono registrado', ownerPhone),
      createDetailRow('Mascota', petSpecies ? `${petName} (${petSpecies})` : petName),
    ];

    if (petAge) {
      rows.push(createDetailRow('Edad aproximada', petAge));
    }

    if (reasonNotes) {
      rows.push(createDetailRow('Motivo de la consulta', reasonNotes));
    }

    const summaryCard = createEl('div', { className: 'summary-card mb-4' }, [header, ...rows]);

    const children = [summaryCard];

    if (canCancel) {
      const arrivalMinutes = Number(getHospitalConfig?.()?.hospital?.arrivalMinutes ?? 15);
      children.push(
        createEl('div', { className: 'info-reminder-box mb-4' }, [
          createEl('i', { className: 'bi bi-clock-fill', 'aria-hidden': 'true' }),
          createEl('p', { className: 'mb-0' }, [
            'Recuerde llegar ',
            createEl('strong', { text: `${arrivalMinutes} minutos antes` }),
            ' de su cita con su mascota en correa o transportadora.',
          ]),
        ]),
        createEl('div', { className: 'step-actions receipt-actions no-print' }, [
          createEl(
            'button',
            {
              type: 'button',
              className: 'btn btn-unam-primary btn-lg-senior',
              onClick: () => printOfficialReceipt(appt, getHospitalConfig?.()?.hospital || {}),
            },
            [
              createEl('i', { className: 'bi bi-file-earmark-pdf-fill me-2', 'aria-hidden': 'true' }),
              'Guardar en PDF / Imprimir',
            ]
          ),
          createEl(
            'button',
            {
              type: 'button',
              id: 'btn-open-cancel-modal',
              className: 'btn btn-unam-danger-outline btn-lg-senior',
              onClick: openCancelModal,
            },
            [
              createEl('i', { className: 'bi bi-x-circle-fill me-2', 'aria-hidden': 'true' }),
              'Cancelar esta cita',
            ]
          ),
        ])
      );
    } else if (statusKey === 'cancelada') {
      children.push(
        createEl('div', { className: 'notice-box' }, [
          createEl('div', { className: 'notice-title', text: 'Esta cita ya está cancelada' }),
          createEl('p', {
            className: 'mb-0',
            text: 'Si necesita una nueva atención para su mascota, puede agendar otra cita en la pestaña "Agendar una cita nueva".',
          }),
        ])
      );
    } else if (statusKey === 'atendida') {
      children.push(
        createEl('div', { className: 'info-reminder-box' }, [
          createEl('i', { className: 'bi bi-check-circle-fill', 'aria-hidden': 'true' }),
          createEl('p', {
            className: 'mb-0',
            text: 'Esta cita ya fue atendida por el personal del hospital. Gracias por confiar en nosotros.',
          }),
        ])
      );
    }

    resultContainer.replaceChildren(...children);
    resultContainer.classList.remove('d-none');
    populateOfficialReceipt(appt, getHospitalConfig?.()?.hospital || {});
  }

  /**
   * Busca la cita en el servidor cuando el usuario envía el formulario.
   * @param {SubmitEvent} event
   */
  async function handleLookupSubmit(event) {
    event.preventDefault();
    showLookupAlert('');

    const folio = folioInput.value.trim().toUpperCase();
    const phoneDigits = extractDigits(phoneInput.value);

    let firstInvalid = null;

    if (!folio) {
      setFieldError('lookup-folio-error', folioInput, 'Por favor escriba el número de folio de su cita.');
      firstInvalid ||= folioInput;
    } else {
      setFieldError('lookup-folio-error', folioInput, '');
    }

    if (phoneDigits.length !== 10) {
      setFieldError(
        'lookup-phone-error',
        phoneInput,
        'Por favor escriba los 10 dígitos del teléfono con el que agendó su cita.'
      );
      firstInvalid ||= phoneInput;
    } else {
      setFieldError('lookup-phone-error', phoneInput, '');
    }

    if (firstInvalid) {
      firstInvalid.focus();
      return;
    }

    folioInput.value = folio;
    resultContainer.classList.add('d-none');
    resultContainer.replaceChildren();

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.replaceChildren(
        createEl('span', {
          className: 'spinner-border spinner-border-sm me-2',
          role: 'status',
          'aria-hidden': 'true',
        }),
        createEl('span', { text: 'Buscando cita...' })
      );
    }

    try {
      const query = new URLSearchParams({ folio, phone: phoneDigits }).toString();
      const response = await apiRequest(`/api/public/appointments/lookup?${query}`);

      state.folio = folio;
      state.phone = phoneDigits;
      state.appointment = response.data || null;

      if (!state.appointment) {
        showLookupAlert(
          'No encontramos una cita con ese folio y teléfono. Verifique que estén escritos correctamente.',
          'warning'
        );
        return;
      }

      renderAppointmentResult(state.appointment);
    } catch (error) {
      showLookupAlert(
        error.message ||
          'No encontramos ninguna cita con esos datos. Verifique su folio y teléfono de 10 dígitos.',
        'danger'
      );
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.replaceChildren(
          createEl('i', { className: 'bi bi-search me-2', 'aria-hidden': 'true' }),
          createEl('span', { text: 'Buscar mi cita' })
        );
      }
    }
  }

  /**
   * Ejecuta la cancelación confirmada en el modal (`POST /api/public/appointments/cancel`).
   */
  async function handleConfirmCancel() {
    if (state.cancelling || !state.appointment) return;
    state.cancelling = true;

    if (cancelModalError) {
      cancelModalError.classList.add('d-none');
      cancelModalError.replaceChildren();
    }

    if (btnConfirmCancel) {
      btnConfirmCancel.disabled = true;
      btnConfirmCancel.replaceChildren(
        createEl('span', {
          className: 'spinner-border spinner-border-sm me-2',
          role: 'status',
          'aria-hidden': 'true',
        }),
        createEl('span', { text: 'Cancelando...' })
      );
    }

    try {
      const response = await apiRequest('/api/public/appointments/cancel', {
        method: 'POST',
        body: {
          folio: state.appointment.folio || state.folio,
          phone: state.phone,
        },
      });

      // Actualizamos el estado local con la cita cancelada y cerramos el modal.
      state.appointment = {
        ...state.appointment,
        ...(response.data || {}),
        status: 'cancelada',
      };

      if (window.bootstrap?.Modal && cancelModalEl) {
        const modalInstance = window.bootstrap.Modal.getOrCreateInstance(cancelModalEl);
        modalInstance.hide();
      }

      showLookupAlert(
        'Su cita ha sido cancelada correctamente y el horario quedó libre. Gracias por avisarnos.',
        'success'
      );
      renderAppointmentResult(state.appointment);
    } catch (error) {
      if (cancelModalError) {
        cancelModalError.classList.remove('d-none');
        cancelModalError.textContent =
          error.message || 'No se pudo cancelar la cita en este momento. Intente nuevamente.';
      }
    } finally {
      state.cancelling = false;
      if (btnConfirmCancel) {
        btnConfirmCancel.disabled = false;
        btnConfirmCancel.replaceChildren(
          createEl('i', { className: 'bi bi-x-circle-fill me-2', 'aria-hidden': 'true' }),
          createEl('span', { text: 'Sí, cancelar mi cita' })
        );
      }
    }
  }

  // Enlace de eventos del formulario y del botón de confirmación del modal
  form.addEventListener('submit', handleLookupSubmit);

  folioInput.addEventListener('input', () => {
    if (folioInput.classList.contains('is-invalid')) {
      setFieldError('lookup-folio-error', folioInput, '');
    }
  });

  phoneInput.addEventListener('input', () => {
    if (phoneInput.classList.contains('is-invalid')) {
      setFieldError('lookup-phone-error', phoneInput, '');
    }
  });

  if (btnConfirmCancel) {
    btnConfirmCancel.addEventListener('click', handleConfirmCancel);
  }
}
