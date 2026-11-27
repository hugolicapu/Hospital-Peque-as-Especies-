/**
 * @file public/js/citas/wizard.js
 * @description Asistente guiado de 4 pasos para agendar citas veterinarias en el
 * Hospital de Pequeñas Especies UNAM FES Cuautitlán (Campo 4).
 *
 * Flujo diseñado para personas mayores:
 * - Paso 1: Elegir el servicio con tarjetas grandes e íconos claros.
 * - Paso 2: Elegir fecha (botones rápidos + calendario) y horario en formato 12h.
 * - Paso 3: Llenar datos del dueño y de la mascota con validación amable campo por campo.
 * - Paso 4: Revisar el resumen completo y confirmar la cita (`POST /api/public/appointments`).
 * - Comprobante: Folio en letra muy grande, botón "Imprimir comprobante" y "Agendar otra cita".
 *
 * Seguridad DOM:
 * Todos los nodos dinámicos se crean con `createEl` y `textContent` (sin `innerHTML`).
 */

import {
  apiRequest,
  createEl,
  formatDateSpanish,
  formatTime12h,
  getLocalIsoDate,
  STATUS_META,
} from '../shared/api.js';
import {
  formatIssuedTimestamp,
  populateOfficialReceipt,
  printOfficialReceipt,
} from './receipt.js';

/** Íconos orientativos para cada tipo de pequeña especie atendida. */
const SPECIES_ICONS = Object.freeze({
  Perro: 'bi-heart-fill',
  Gato: 'bi-stars',
  Ave: 'bi-feather',
  'Conejo / Roedor': 'bi-flower1',
  Reptil: 'bi-shield-fill',
  'Otra pequeña especie': 'bi-plus-circle-fill',
});

/**
 * Obtiene el día de la semana local (0 = Domingo ... 6 = Sábado) para una fecha 'YYYY-MM-DD'.
 * @param {string} isoDate
 * @returns {number}
 */
function getDayOfWeekFromIso(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(year, month - 1, day).getDay();
}

/**
 * Formatea una fecha 'YYYY-MM-DD' en texto corto amigable (ej. "vie 27 nov").
 * @param {string} isoDate
 * @returns {string}
 */
function formatShortDateSpanish(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const dateObj = new Date(year, month - 1, day);
  return new Intl.DateTimeFormat('es-MX', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(dateObj);
}

/**
 * Extrae solo los dígitos de un número telefónico escrito por el usuario.
 * @param {string} value
 * @returns {string}
 */
function extractPhoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

/**
 * Inicializa todo el asistente guiado de 4 pasos y devuelve controladores para
 * inyectar la configuración proveniente de `/api/public/config`.
 *
 * @param {object} options
 * @param {(msg: string) => void} options.announce - Notificador para lector de pantalla.
 * @param {() => Promise<void>} options.onRetryConfig - Reintento de carga inicial.
 */
export function initWizard({ announce, onRetryConfig }) {
  // Estado centralizado del asistente de 4 pasos.
  const state = {
    config: null,
    currentStep: 1,
    highestCompletedStep: 0,
    selectedService: null,
    selectedDate: '',
    selectedTime: '',
    availabilityRequestId: 0,
    formValues: {
      ownerName: '',
      ownerPhone: '',
      ownerEmail: '',
      petSpecies: '',
      petName: '',
      petAge: '',
      reasonNotes: '',
    },
    submitting: false,
    createdAppointment: null,
  };

  // Referencias principales del DOM
  const wizardContainer = document.getElementById('wizard-container');
  const receiptSection = document.getElementById('booking-receipt');
  const stepCounterEl = document.getElementById('wizard-step-counter');

  const stepPanels = {
    1: document.getElementById('wizard-step-1'),
    2: document.getElementById('wizard-step-2'),
    3: document.getElementById('wizard-step-3'),
    4: document.getElementById('wizard-step-4'),
  };

  // Paso 1
  const servicesAlert = document.getElementById('services-alert');
  const servicesLoading = document.getElementById('services-loading');
  const servicesGrid = document.getElementById('services-grid');
  const btnStep1Next = document.getElementById('btn-step1-next');

  // Paso 2
  const step2ServiceSummary = document.getElementById('step2-selected-service-summary');
  const availabilityAlert = document.getElementById('availability-alert');
  const quickDatesContainer = document.getElementById('quick-dates-container');
  const dateInput = document.getElementById('appointment-date-input');
  const selectedDateReadable = document.getElementById('selected-date-readable');
  const slotsLoading = document.getElementById('slots-loading');
  const slotsStatusMessage = document.getElementById('slots-status-message');
  const slotsGrid = document.getElementById('slots-grid');
  const btnStep2Back = document.getElementById('btn-step2-back');
  const btnStep2Next = document.getElementById('btn-step2-next');

  // Paso 3
  const step3ContextSummary = document.getElementById('step3-context-summary');
  const step3Alert = document.getElementById('step3-alert');
  const detailsForm = document.getElementById('wizard-details-form');
  const speciesGrid = document.getElementById('species-grid');
  const ownerNameInput = document.getElementById('owner-name');
  const ownerPhoneInput = document.getElementById('owner-phone');
  const ownerEmailInput = document.getElementById('owner-email');
  const petNameInput = document.getElementById('pet-name');
  const petAgeInput = document.getElementById('pet-age');
  const reasonNotesInput = document.getElementById('reason-notes');
  const btnStep3Back = document.getElementById('btn-step3-back');

  // Paso 4
  const step4Alert = document.getElementById('step4-alert');
  const reviewSummaryCard = document.getElementById('review-summary-card');
  const btnStep4Back = document.getElementById('btn-step4-back');
  const btnStep4Confirm = document.getElementById('btn-step4-confirm');

  // Pantalla de éxito / Comprobante
  const receiptFolioEl = document.getElementById('receipt-folio');
  const receiptStatusPillEl = document.getElementById('receipt-status-pill');
  const receiptIssuedAtEl = document.getElementById('receipt-issued-at');
  const receiptDetailsEl = document.getElementById('receipt-details');
  const receiptArrivalNoteEl = document.getElementById('receipt-arrival-note');
  const receiptHospitalContactEl = document.getElementById('receipt-hospital-contact');
  const btnCopyFolio = document.getElementById('btn-copy-folio');
  const copyFolioFeedback = document.getElementById('copy-folio-feedback');
  const btnPrintReceipt = document.getElementById('btn-print-receipt');
  const btnBookAnother = document.getElementById('btn-book-another');

  /**
   * Muestra u oculta una caja de alerta con texto seguro y estilo semántico.
   * @param {HTMLElement|null} el
   * @param {string} message
   * @param {'danger'|'warning'|'success'} [type='danger']
   */
  function showAlert(el, message, type = 'danger') {
    if (!el) return;
    if (!message) {
      el.classList.add('d-none');
      el.replaceChildren();
      return;
    }

    el.className = `alert-box alert-box-${type}`;
    const iconClass =
      type === 'success'
        ? 'bi-check-circle-fill'
        : type === 'warning'
          ? 'bi-exclamation-triangle-fill'
          : 'bi-exclamation-circle-fill';

    el.replaceChildren(
      createEl('div', { className: 'd-flex align-items-start gap-2' }, [
        createEl('i', { className: `bi ${iconClass} mt-1`, 'aria-hidden': 'true' }),
        createEl('span', { text: message }),
      ])
    );
  }

  /**
   * Actualiza los indicadores visuales de paso (Paso X de 4) y habilita el
   * regreso a pasos ya completados.
   */
  function updateStepperUI() {
    if (stepCounterEl) {
      stepCounterEl.textContent = `Paso ${state.currentStep} de 4`;
    }

    for (let step = 1; step <= 4; step += 1) {
      const item = document.getElementById(`step-indicator-${step}`);
      if (!item) continue;
      const btn = item.querySelector('.stepper-btn');
      const circle = item.querySelector('.stepper-circle');

      item.classList.remove('active', 'completed');
      item.removeAttribute('aria-current');

      if (step === state.currentStep) {
        item.classList.add('active');
        item.setAttribute('aria-current', 'step');
        if (circle) circle.textContent = String(step);
        if (btn) btn.disabled = true;
      } else if (step < state.currentStep || step <= state.highestCompletedStep) {
        item.classList.add('completed');
        if (circle) {
          circle.replaceChildren(createEl('i', { className: 'bi bi-check-lg', 'aria-hidden': 'true' }));
        }
        if (btn) btn.disabled = false;
      } else {
        if (circle) circle.textContent = String(step);
        if (btn) btn.disabled = true;
      }
    }
  }

  /**
   * Cambia el paso visible del asistente y coloca el foco en el título del paso
   * para orientar de inmediato a personas mayores y lectores de pantalla.
   * @param {number} targetStep
   * @param {boolean} [shouldScroll=true]
   */
  function goToStep(targetStep, shouldScroll = true) {
    state.currentStep = targetStep;

    if (receiptSection) receiptSection.classList.add('d-none');
    if (wizardContainer) wizardContainer.classList.remove('d-none');

    Object.entries(stepPanels).forEach(([stepNum, panel]) => {
      if (!panel) return;
      panel.classList.toggle('d-none', Number(stepNum) !== targetStep);
    });

    updateStepperUI();

    if (targetStep === 2) {
      renderStep2Context();
      // Al entrar por primera vez al Paso 2, preseleccionamos el primer día hábil disponible.
      if (!state.selectedDate) {
        const defaultDate = findFirstOpenIsoDate();
        selectDate(defaultDate);
      }
    } else if (targetStep === 3) {
      renderStep3Context();
    } else if (targetStep === 4) {
      renderStep4Review();
    }

    const heading = document.getElementById(`step-${targetStep}-heading`);
    if (heading && shouldScroll) {
      heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
      heading.focus({ preventScroll: true });
    }

    announce(`Paso ${targetStep} de 4.`);
  }

  /* ---------------------------------------------------------------------------
     PASO 1: SERVICIOS VETERINARIOS
     --------------------------------------------------------------------------- */

  /**
   * Renderiza las tarjetas grandes de servicios activos desde `/api/public/config`.
   */
  function renderServices() {
    if (!servicesGrid) return;
    servicesGrid.replaceChildren();

    const services = Array.isArray(state.config?.services) ? state.config.services : [];

    if (services.length === 0) {
      showAlert(
        servicesAlert,
        'Por el momento no hay servicios habilitados para agendar en línea. Por favor comuníquese al teléfono del hospital.',
        'warning'
      );
      return;
    }

    showAlert(servicesAlert, '');

    services.forEach((service) => {
      const isSelected = state.selectedService && state.selectedService.id === service.id;
      const duration = service.durationMinutes ?? service.duration_minutes ?? 60;
      const iconClass = service.icon || 'bi-heart-pulse-fill';

      const cardBtn = createEl(
        'button',
        {
          type: 'button',
          className: `service-card${isSelected ? ' selected' : ''}`,
          'aria-pressed': String(Boolean(isSelected)),
          onClick: () => {
            state.selectedService = service;
            showAlert(servicesAlert, '');
            renderServices();
            announce(`Servicio seleccionado: ${service.name}.`);
          },
        },
        [
          createEl('div', { className: 'service-card-top' }, [
            createEl('div', { className: 'service-icon-wrap', 'aria-hidden': 'true' }, [
              createEl('i', { className: `bi ${iconClass}` }),
            ]),
            createEl('div', {}, [
              createEl('div', { className: 'service-name', text: service.name }),
              createEl('p', {
                className: 'service-desc',
                text: service.description || 'Atención veterinaria profesional.',
              }),
            ]),
          ]),
          createEl('div', { className: 'service-card-footer' }, [
            createEl('span', { className: 'service-duration' }, [
              createEl('i', { className: 'bi bi-clock me-1', 'aria-hidden': 'true' }),
              `Duración aproximada: ${duration} min`,
            ]),
            isSelected
              ? createEl('span', { className: 'service-selected-badge' }, [
                  createEl('i', { className: 'bi bi-check-circle-fill', 'aria-hidden': 'true' }),
                  'Seleccionado',
                ])
              : createEl('span', { className: 'service-duration', text: 'Toque para elegir' }),
          ]),
        ]
      );

      servicesGrid.appendChild(cardBtn);
    });
  }

  /* ---------------------------------------------------------------------------
     PASO 2: SELECCIÓN DE FECHA Y HORARIO
     --------------------------------------------------------------------------- */

  /**
   * Verifica según las reglas semanales cargadas si un día suele abrir el hospital.
   * @param {string} isoDate
   * @returns {boolean}
   */
  function isDayNormallyOpen(isoDate) {
    const rules = state.config?.schedule;
    if (!Array.isArray(rules) || rules.length === 0) return true;
    const dow = getDayOfWeekFromIso(isoDate);
    const rule = rules.find((item) => Number(item.dayOfWeek ?? item.day_of_week) === dow);
    if (!rule) return true;
    return Boolean(rule.isOpen ?? rule.is_open);
  }

  /**
   * Busca el primer día abierto a partir de hoy dentro del rango permitido.
   * @returns {string}
   */
  function findFirstOpenIsoDate() {
    const maxDays = Number(state.config?.maxDaysAhead ?? state.config?.hospital?.maxDaysAhead ?? 30);
    for (let offset = 0; offset <= Math.min(maxDays, 14); offset += 1) {
      const candidate = getLocalIsoDate(offset);
      if (isDayNormallyOpen(candidate)) {
        return candidate;
      }
    }
    return getLocalIsoDate(0);
  }

  /**
   * Construye la lista de botones rápidos: "Hoy", "Mañana" y los próximos días
   * abiertos del hospital (hasta 6 botones claros).
   */
  function renderQuickDates() {
    if (!quickDatesContainer) return;
    quickDatesContainer.replaceChildren();

    const maxDays = Number(state.config?.maxDaysAhead ?? state.config?.hospital?.maxDaysAhead ?? 30);
    const items = [];
    const seen = new Set();

    const todayIso = getLocalIsoDate(0);
    const tomorrowIso = getLocalIsoDate(1);

    items.push({
      iso: todayIso,
      title: 'Hoy',
      sub: `${formatShortDateSpanish(todayIso)}${isDayNormallyOpen(todayIso) ? '' : ' (Cerrado)'}`,
    });
    seen.add(todayIso);

    if (maxDays >= 1) {
      items.push({
        iso: tomorrowIso,
        title: 'Mañana',
        sub: `${formatShortDateSpanish(tomorrowIso)}${isDayNormallyOpen(tomorrowIso) ? '' : ' (Cerrado)'}`,
      });
      seen.add(tomorrowIso);
    }

    // Agregamos hasta 4 próximos días hábiles abiertos adicionales.
    for (let offset = 2; offset <= maxDays && items.length < 6; offset += 1) {
      const candidate = getLocalIsoDate(offset);
      if (seen.has(candidate) || !isDayNormallyOpen(candidate)) continue;
      seen.add(candidate);
      const shortDate = formatShortDateSpanish(candidate);
      const [weekdayPart, ...restParts] = shortDate.split(',');
      items.push({
        iso: candidate,
        title: weekdayPart ? weekdayPart.charAt(0).toUpperCase() + weekdayPart.slice(1) : shortDate,
        sub: restParts.join(',').trim() || shortDate,
      });
    }

    items.forEach((item) => {
      const isSelected = state.selectedDate === item.iso;
      const btn = createEl(
        'button',
        {
          type: 'button',
          className: `quick-date-btn${isSelected ? ' selected' : ''}`,
          'aria-pressed': String(isSelected),
          onClick: () => selectDate(item.iso),
        },
        [
          createEl('span', { className: 'quick-date-title', text: item.title }),
          createEl('span', { className: 'quick-date-sub', text: item.sub }),
        ]
      );
      quickDatesContainer.appendChild(btn);
    });
  }

  /**
   * Actualiza el recordatorio del servicio seleccionado arriba del Paso 2.
   */
  function renderStep2Context() {
    if (!step2ServiceSummary || !state.selectedService) return;
    step2ServiceSummary.replaceChildren(
      createEl('strong', { text: 'Servicio elegido: ' }),
      createEl('span', { text: state.selectedService.name })
    );
  }

  /**
   * Selecciona una fecha, actualiza el calendario y consulta disponibilidad al servidor.
   * @param {string} isoDate
   */
  async function selectDate(isoDate) {
    if (!isoDate) return;
    state.selectedDate = isoDate;
    state.selectedTime = '';
    showAlert(availabilityAlert, '');

    if (dateInput) {
      dateInput.value = isoDate;
    }
    if (selectedDateReadable) {
      selectedDateReadable.textContent = formatDateSpanish(isoDate);
    }

    renderQuickDates();
    await loadAvailabilityForDate(isoDate);
  }

  /**
   * Muestra un aviso amable en el contenedor de horarios (día cerrado, bloqueado o sin cupo).
   * @param {string} title
   * @param {string} description
   */
  function showSlotsNotice(title, description) {
    if (!slotsStatusMessage) return;
    slotsStatusMessage.classList.remove('d-none');
    slotsStatusMessage.replaceChildren(
      createEl('div', { className: 'd-flex align-items-start gap-3' }, [
        createEl('i', { className: 'bi bi-calendar-x-fill fs-3', 'aria-hidden': 'true' }),
        createEl('div', {}, [
          createEl('div', { className: 'notice-title', text: title }),
          createEl('p', { className: 'mb-0', text: description }),
        ]),
      ])
    );
  }

  /**
   * Consulta `GET /api/public/availability?date=YYYY-MM-DD` y dibuja los botones
   * grandes de horarios en formato 12 horas legible.
   * @param {string} isoDate
   */
  async function loadAvailabilityForDate(isoDate) {
    const requestId = ++state.availabilityRequestId;

    if (slotsGrid) slotsGrid.replaceChildren();
    if (slotsStatusMessage) {
      slotsStatusMessage.classList.add('d-none');
      slotsStatusMessage.replaceChildren();
    }
    if (slotsLoading) slotsLoading.classList.remove('d-none');

    try {
      const response = await apiRequest(
        `/api/public/availability?date=${encodeURIComponent(isoDate)}`
      );

      // Si el usuario cambió rápido a otra fecha, descartamos la respuesta anterior.
      if (requestId !== state.availabilityRequestId) return;

      const data = response.data || {};
      const slots = Array.isArray(data.slots) ? data.slots : [];

      if (data.dayBlocked) {
        const reason = data.blockReason
          ? `Motivo indicado por el hospital: ${data.blockReason}.`
          : 'El hospital no tiene consultas programadas en esta fecha.';
        showSlotsNotice(
          'Este día no hay atención en el hospital',
          `${reason} Por favor elija otro día en los botones de arriba o en el calendario.`
        );
        return;
      }

      if (data.isOpen === false) {
        showSlotsNotice(
          'El hospital permanece cerrado este día',
          'Por favor elija otro día hábil usando los botones rápidos de arriba o el calendario.'
        );
        return;
      }

      if (slots.length === 0) {
        showSlotsNotice(
          'No encontramos horarios disponibles para esta fecha',
          'Por favor intente seleccionando otro día en el calendario.'
        );
        return;
      }

      const availableCount = slots.filter((slot) => Boolean(slot.isAvailable)).length;
      if (availableCount === 0) {
        showSlotsNotice(
          'Todos los horarios de este día ya están ocupados o ya pasaron',
          'Le recomendamos elegir el siguiente día disponible usando los botones de arriba.'
        );
      }

      renderSlotButtons(slots);
    } catch (error) {
      if (requestId !== state.availabilityRequestId) return;
      showAlert(
        availabilityAlert,
        error.message || 'No fue posible consultar los horarios de esta fecha. Intente de nuevo.',
        'danger'
      );
    } finally {
      if (requestId === state.availabilityRequestId && slotsLoading) {
        slotsLoading.classList.add('d-none');
      }
    }
  }

  /**
   * Dibuja la cuadrícula de botones grandes de horarios para el día elegido.
   * @param {Array<object>} slots
   */
  function renderSlotButtons(slots) {
    if (!slotsGrid) return;
    slotsGrid.replaceChildren();

    slots.forEach((slot) => {
      const isAvailable = Boolean(slot.isAvailable);
      const isSelected = isAvailable && state.selectedTime === slot.time;
      const availableSpots = Number(slot.available ?? 0);
      const totalCapacity = Number(slot.capacity ?? 1);

      let spotsLabel = 'Ocupado';
      if (isAvailable) {
        if (totalCapacity === 1) {
          spotsLabel = 'Disponible';
        } else {
          spotsLabel =
            availableSpots === 1 ? '1 lugar disponible' : `${availableSpots} lugares disponibles`;
        }
      } else if (slot.reason) {
        spotsLabel = slot.reason === 'Cupo lleno' && totalCapacity === 1 ? 'Ocupado' : slot.reason;
      }

      const slotBtn = createEl(
        'button',
        {
          type: 'button',
          className: `slot-btn${isSelected ? ' selected' : ''}`,
          disabled: !isAvailable,
          'aria-pressed': String(isSelected),
          onClick: () => {
            state.selectedTime = slot.time;
            showAlert(availabilityAlert, '');
            renderSlotButtons(slots);
            announce(`Horario seleccionado: ${formatTime12h(slot.time)}.`);
          },
        },
        [
          createEl('span', { className: 'slot-time-text', text: formatTime12h(slot.time) }),
          createEl('span', { className: 'slot-spots-text', text: spotsLabel }),
        ]
      );

      slotsGrid.appendChild(slotBtn);
    });
  }

  /* ---------------------------------------------------------------------------
     PASO 3: FORMULARIO DE DATOS DEL DUEÑO Y LA MASCOTA
     --------------------------------------------------------------------------- */

  /**
   * Dibuja los botones grandes para elegir la especie de la mascota.
   */
  function renderSpeciesButtons() {
    if (!speciesGrid) return;
    speciesGrid.replaceChildren();

    const speciesList =
      Array.isArray(state.config?.species) && state.config.species.length > 0
        ? state.config.species
        : ['Perro', 'Gato', 'Ave', 'Conejo / Roedor', 'Reptil', 'Otra pequeña especie'];

    speciesList.forEach((speciesName) => {
      const isSelected = state.formValues.petSpecies === speciesName;
      const iconClass = SPECIES_ICONS[speciesName] || 'bi-heart-fill';

      const btn = createEl(
        'button',
        {
          type: 'button',
          className: `species-btn${isSelected ? ' selected' : ''}`,
          'aria-pressed': String(isSelected),
          onClick: () => {
            state.formValues.petSpecies = speciesName;
            setFieldError('pet-species-error', null, '');
            renderSpeciesButtons();
            announce(`Especie seleccionada: ${speciesName}.`);
          },
        },
        [
          createEl('i', { className: `bi ${iconClass}`, 'aria-hidden': 'true' }),
          createEl('span', { text: speciesName }),
        ]
      );

      speciesGrid.appendChild(btn);
    });
  }

  /**
   * Muestra el resumen del servicio, fecha y hora elegidos al inicio del Paso 3.
   */
  function renderStep3Context() {
    if (!step3ContextSummary) return;
    const serviceName = state.selectedService?.name || '';
    const readableDate = formatDateSpanish(state.selectedDate);
    const readableTime = formatTime12h(state.selectedTime);

    step3ContextSummary.replaceChildren(
      createEl('strong', { text: 'Cita elegida: ' }),
      createEl('span', { text: `${serviceName} · ${readableDate} a las ${readableTime}` })
    );
  }

  /**
   * Asigna o limpia el mensaje de error amable debajo de un campo específico.
   * @param {string} errorId
   * @param {HTMLElement|null} inputEl
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

    if (inputEl) {
      inputEl.classList.toggle('is-invalid', Boolean(message));
      inputEl.setAttribute('aria-invalid', message ? 'true' : 'false');
    }
  }

  /**
   * Valida cada campo del Paso 3 con mensajes en español sencillos y directos.
   * Devuelve `true` si todo es válido, o enfoca el primer campo con error.
   * @returns {boolean}
   */
  function validateStep3Fields() {
    let firstInvalidTarget = null;

    const ownerName = (ownerNameInput?.value || '').trim();
    const ownerPhoneRaw = (ownerPhoneInput?.value || '').trim();
    const ownerPhoneDigits = extractPhoneDigits(ownerPhoneRaw);
    const ownerEmail = (ownerEmailInput?.value || '').trim();
    const petName = (petNameInput?.value || '').trim();
    const petAge = (petAgeInput?.value || '').trim();
    const reasonNotes = (reasonNotesInput?.value || '').trim();

    // 1. Nombre completo del dueño
    if (ownerName.length < 3) {
      setFieldError(
        'owner-name-error',
        ownerNameInput,
        'Por favor escriba el nombre completo del dueño o tutor (al menos 3 letras).'
      );
      firstInvalidTarget ||= ownerNameInput;
    } else {
      setFieldError('owner-name-error', ownerNameInput, '');
    }

    // 2. Teléfono a 10 dígitos
    if (!ownerPhoneDigits) {
      setFieldError(
        'owner-phone-error',
        ownerPhoneInput,
        'Por favor escriba un teléfono de contacto a 10 dígitos.'
      );
      firstInvalidTarget ||= ownerPhoneInput;
    } else if (ownerPhoneDigits.length !== 10) {
      setFieldError(
        'owner-phone-error',
        ownerPhoneInput,
        `El teléfono debe tener exactamente 10 números (actualmente escribió ${ownerPhoneDigits.length}).`
      );
      firstInvalidTarget ||= ownerPhoneInput;
    } else {
      setFieldError('owner-phone-error', ownerPhoneInput, '');
    }

    // 3. Correo electrónico (opcional, solo se valida si el usuario escribió algo)
    if (ownerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
      setFieldError(
        'owner-email-error',
        ownerEmailInput,
        'El correo electrónico no parece estar completo. Ejemplo: maria@correo.com (o déjelo vacío).'
      );
      firstInvalidTarget ||= ownerEmailInput;
    } else {
      setFieldError('owner-email-error', ownerEmailInput, '');
    }

    // 4. Especie de la mascota
    if (!state.formValues.petSpecies) {
      setFieldError(
        'pet-species-error',
        null,
        'Por favor seleccione qué tipo de mascota es tocando uno de los recuadros.'
      );
      firstInvalidTarget ||= speciesGrid?.querySelector('button') || speciesGrid;
    } else {
      setFieldError('pet-species-error', null, '');
    }

    // 5. Nombre de la mascota
    if (petName.length < 1) {
      setFieldError(
        'pet-name-error',
        petNameInput,
        'Por favor escriba el nombre de su mascota.'
      );
      firstInvalidTarget ||= petNameInput;
    } else {
      setFieldError('pet-name-error', petNameInput, '');
    }

    // 6. Edad y motivo (opcionales, solo límite de longitud)
    setFieldError('pet-age-error', petAgeInput, '');
    setFieldError('reason-notes-error', reasonNotesInput, '');

    if (firstInvalidTarget) {
      showAlert(
        step3Alert,
        'Faltan algunos datos obligatorios o tienen un pequeño error. Revise los mensajes en rojo.',
        'danger'
      );
      if (typeof firstInvalidTarget.focus === 'function') {
        firstInvalidTarget.focus();
      }
      firstInvalidTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return false;
    }

    // Guardamos los valores limpios en el estado
    state.formValues.ownerName = ownerName;
    state.formValues.ownerPhone = ownerPhoneDigits;
    state.formValues.ownerEmail = ownerEmail;
    state.formValues.petName = petName;
    state.formValues.petAge = petAge;
    state.formValues.reasonNotes = reasonNotes;

    showAlert(step3Alert, '');
    return true;
  }

  /* ---------------------------------------------------------------------------
     PASO 4: REVISIÓN Y CONFIRMACIÓN DE LA CITA
     --------------------------------------------------------------------------- */

  /**
   * Crea una fila de resumen segura (`clave -> valor`) para las tarjetas de
   * confirmación y comprobante final.
   * @param {string} label
   * @param {string} value
   * @returns {HTMLElement}
   */
  function createSummaryRow(label, value) {
    return createEl('div', { className: 'summary-row' }, [
      createEl('div', { className: 'summary-key', text: label }),
      createEl('div', { className: 'summary-value', text: value }),
    ]);
  }

  /**
   * Dibuja la tarjeta grande de revisión antes de confirmar la cita.
   */
  function renderStep4Review() {
    if (!reviewSummaryCard) return;
    showAlert(step4Alert, '');

    const rows = [
      createSummaryRow('Servicio solicitado', state.selectedService?.name || ''),
      createSummaryRow('Día de la cita', formatDateSpanish(state.selectedDate)),
      createSummaryRow('Hora elegida', formatTime12h(state.selectedTime)),
      createSummaryRow('Nombre del dueño o tutor', state.formValues.ownerName),
      createSummaryRow('Teléfono de contacto', state.formValues.ownerPhone),
    ];

    if (state.formValues.ownerEmail) {
      rows.push(createSummaryRow('Correo electrónico', state.formValues.ownerEmail));
    }

    rows.push(
      createSummaryRow('Nombre de la mascota', state.formValues.petName),
      createSummaryRow('Tipo de mascota', state.formValues.petSpecies)
    );

    if (state.formValues.petAge) {
      rows.push(createSummaryRow('Edad aproximada', state.formValues.petAge));
    }

    if (state.formValues.reasonNotes) {
      rows.push(createSummaryRow('Motivo de la consulta', state.formValues.reasonNotes));
    }

    // Barra de atajos rápidos por si el usuario quiere corregir el servicio o la hora directamente.
    const quickEditBar = createEl('div', { className: 'summary-edit-bar' }, [
      createEl(
        'button',
        {
          type: 'button',
          className: 'btn btn-unam-outline btn-sm-senior',
          onClick: () => goToStep(1),
        },
        [
          createEl('i', { className: 'bi bi-arrow-repeat me-1', 'aria-hidden': 'true' }),
          'Cambiar servicio',
        ]
      ),
      createEl(
        'button',
        {
          type: 'button',
          className: 'btn btn-unam-outline btn-sm-senior',
          onClick: () => goToStep(2),
        },
        [
          createEl('i', { className: 'bi bi-calendar2-week me-1', 'aria-hidden': 'true' }),
          'Cambiar día u hora',
        ]
      ),
    ]);

    reviewSummaryCard.replaceChildren(...rows, quickEditBar);
  }

  /**
   * Envía la cita al backend (`POST /api/public/appointments`) y muestra la
   * pantalla de éxito con el folio en letra muy grande.
   */
  async function handleConfirmAppointment() {
    if (state.submitting) return;
    state.submitting = true;
    showAlert(step4Alert, '');

    if (btnStep4Confirm) {
      btnStep4Confirm.disabled = true;
      btnStep4Confirm.replaceChildren(
        createEl('span', {
          className: 'spinner-border spinner-border-sm me-2',
          role: 'status',
          'aria-hidden': 'true',
        }),
        createEl('span', { text: 'Guardando su cita...' })
      );
    }

    try {
      const payload = {
        serviceId: state.selectedService.id,
        date: state.selectedDate,
        time: state.selectedTime,
        ownerName: state.formValues.ownerName,
        ownerPhone: state.formValues.ownerPhone,
        ownerEmail: state.formValues.ownerEmail || undefined,
        petName: state.formValues.petName,
        petSpecies: state.formValues.petSpecies,
        petAge: state.formValues.petAge || undefined,
        reasonNotes: state.formValues.reasonNotes || undefined,
      };

      const response = await apiRequest('/api/public/appointments', {
        method: 'POST',
        body: payload,
      });

      state.createdAppointment = response.data || {};
      renderSuccessReceipt(state.createdAppointment);
    } catch (error) {
      const detailsText = Array.isArray(error.details) && error.details.length > 0
        ? ` ${error.details.map((item) => item.message).join(' ')}`
        : '';

      showAlert(
        step4Alert,
        `${error.message || 'No fue posible agendar su cita en este momento.'}${detailsText}`,
        'danger'
      );
    } finally {
      state.submitting = false;
      if (btnStep4Confirm) {
        btnStep4Confirm.disabled = false;
        btnStep4Confirm.replaceChildren(
          createEl('i', { className: 'bi bi-check-circle-fill me-2', 'aria-hidden': 'true' }),
          createEl('span', { text: 'Confirmar mi cita' })
        );
      }
    }
  }

  /**
   * Muestra el comprobante final tras confirmar la cita con el folio en letra muy grande.
   * @param {object} appointment
   */
  function renderSuccessReceipt(appointment) {
    const folio = appointment.folio || '';
    const serviceName =
      appointment.serviceName || appointment.service_name || state.selectedService?.name || '';
    const dateVal = appointment.date || appointment.appointment_date || state.selectedDate;
    const timeVal = appointment.time || appointment.appointment_time || state.selectedTime;
    const ownerName = appointment.ownerName || appointment.owner_name || state.formValues.ownerName;
    const ownerPhone =
      appointment.ownerPhone || appointment.owner_phone || state.formValues.ownerPhone;
    const petName = appointment.petName || appointment.pet_name || state.formValues.petName;
    const petSpecies =
      appointment.petSpecies || appointment.pet_species || state.formValues.petSpecies;
    const statusKey = appointment.status || 'pendiente';
    const statusMeta = STATUS_META[statusKey] || {
      label: statusKey,
      badgeClass: 'text-bg-warning',
    };

    if (receiptFolioEl) {
      receiptFolioEl.textContent = folio;
    }

    if (receiptStatusPillEl) {
      receiptStatusPillEl.className = `badge status-pill ${statusMeta.badgeClass}`;
      receiptStatusPillEl.textContent = statusMeta.label;
    }

    if (receiptIssuedAtEl) {
      receiptIssuedAtEl.textContent = `Emitido: ${formatIssuedTimestamp()}`;
    }

    if (copyFolioFeedback) {
      copyFolioFeedback.classList.add('d-none');
      copyFolioFeedback.textContent = '';
    }

    if (receiptDetailsEl) {
      const detailRows = [
        createSummaryRow('Servicio', serviceName),
        createSummaryRow('Día de la cita', formatDateSpanish(dateVal)),
        createSummaryRow('Hora de la cita', `${formatTime12h(timeVal)} (${timeVal} hrs)`),
        createSummaryRow('Dueño o tutor', ownerName),
        createSummaryRow('Teléfono registrado', ownerPhone),
        createSummaryRow('Mascota', `${petName} (${petSpecies})`),
      ];
      if (state.formValues.petAge) {
        detailRows.push(createSummaryRow('Edad aproximada', state.formValues.petAge));
      }
      if (state.formValues.reasonNotes) {
        detailRows.push(createSummaryRow('Motivo de la consulta', state.formValues.reasonNotes));
      }
      detailRows.push(createSummaryRow('Estado de la cita', statusMeta.label));
      receiptDetailsEl.replaceChildren(...detailRows);
    }

    const arrivalMinutes = Number(state.config?.hospital?.arrivalMinutes ?? 15);
    if (receiptArrivalNoteEl) {
      receiptArrivalNoteEl.replaceChildren(
        'Por favor llegue ',
        createEl('strong', { text: `${arrivalMinutes} minutos antes` }),
        ' de su horario para agilizar su registro en recepción.'
      );
    }

    const hospital = state.config?.hospital || {};
    if (receiptHospitalContactEl && (hospital.address || hospital.phone)) {
      const parts = [];
      if (hospital.address) parts.push(`Dirección: ${hospital.address}`);
      if (hospital.phone) parts.push(`Teléfono de apoyo: ${hospital.phone}`);
      receiptHospitalContactEl.textContent = parts.join(' · ');
    }

    if (wizardContainer) wizardContainer.classList.add('d-none');
    if (receiptSection) receiptSection.classList.remove('d-none');

    // Prepara de inmediato la hoja oficial PDF por si el usuario presiona Ctrl+P
    populateOfficialReceipt(
      {
        ...appointment,
        serviceName,
        date: dateVal,
        time: timeVal,
        ownerName,
        ownerPhone,
        petName,
        petSpecies,
        petAge: appointment.petAge || state.formValues.petAge,
        reasonNotes: appointment.reasonNotes || state.formValues.reasonNotes,
        status: statusKey,
      },
      state.config?.hospital || {}
    );

    const receiptHeading = document.getElementById('receipt-heading');
    if (receiptHeading) {
      receiptHeading.scrollIntoView({ behavior: 'smooth', block: 'start' });
      receiptHeading.focus({ preventScroll: true });
    }

    announce(`Cita confirmada con éxito. Su número de folio es ${folio}.`);
  }

  /**
   * Reinicia completamente el asistente para agendar una nueva cita desde el Paso 1.
   */
  function resetWizardForNewBooking() {
    state.currentStep = 1;
    state.highestCompletedStep = 0;
    state.selectedService = null;
    state.selectedDate = '';
    state.selectedTime = '';
    state.createdAppointment = null;
    state.formValues = {
      ownerName: '',
      ownerPhone: '',
      ownerEmail: '',
      petSpecies: '',
      petName: '',
      petAge: '',
      reasonNotes: '',
    };

    if (detailsForm) detailsForm.reset();
    [
      ['owner-name-error', ownerNameInput],
      ['owner-phone-error', ownerPhoneInput],
      ['owner-email-error', ownerEmailInput],
      ['pet-species-error', null],
      ['pet-name-error', petNameInput],
      ['pet-age-error', petAgeInput],
      ['reason-notes-error', reasonNotesInput],
    ].forEach(([errId, el]) => setFieldError(errId, el, ''));

    showAlert(servicesAlert, '');
    showAlert(availabilityAlert, '');
    showAlert(step3Alert, '');
    showAlert(step4Alert, '');

    renderServices();
    renderSpeciesButtons();
    goToStep(1, true);
  }

  /* ---------------------------------------------------------------------------
     ENLACE DE EVENTOS DE NAVEGACIÓN Y VALIDACIÓN EN VIVO
     --------------------------------------------------------------------------- */

  // Clic en pasos ya completados de la barra de progreso
  document.querySelectorAll('#stepper-list .stepper-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const stepNum = Number(btn.getAttribute('data-go-step'));
      if (stepNum >= 1 && stepNum <= 4 && stepNum <= Math.max(state.currentStep, state.highestCompletedStep)) {
        goToStep(stepNum);
      }
    });
  });

  // Paso 1 -> Paso 2
  if (btnStep1Next) {
    btnStep1Next.addEventListener('click', () => {
      if (!state.selectedService) {
        showAlert(
          servicesAlert,
          'Por favor toque primero uno de los servicios disponibles para poder continuar.',
          'warning'
        );
        return;
      }
      state.highestCompletedStep = Math.max(state.highestCompletedStep, 1);
      goToStep(2);
    });
  }

  // Cambio manual en el selector de fecha del calendario
  if (dateInput) {
    dateInput.addEventListener('change', () => {
      if (dateInput.value) {
        selectDate(dateInput.value);
      }
    });
  }

  // Paso 2 -> Paso 1 / Paso 3
  if (btnStep2Back) {
    btnStep2Back.addEventListener('click', () => goToStep(1));
  }

  if (btnStep2Next) {
    btnStep2Next.addEventListener('click', () => {
      if (!state.selectedDate) {
        showAlert(availabilityAlert, 'Por favor elija primero un día para su cita.', 'warning');
        return;
      }
      if (!state.selectedTime) {
        showAlert(
          availabilityAlert,
          'Por favor toque uno de los horarios disponibles antes de continuar.',
          'warning'
        );
        return;
      }
      state.highestCompletedStep = Math.max(state.highestCompletedStep, 2);
      goToStep(3);
    });
  }

  // Paso 3 -> Paso 2 / Paso 4
  if (btnStep3Back) {
    btnStep3Back.addEventListener('click', () => goToStep(2));
  }

  if (detailsForm) {
    detailsForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!validateStep3Fields()) return;
      state.highestCompletedStep = Math.max(state.highestCompletedStep, 3);
      goToStep(4);
    });
  }

  // Limpiar mensajes de error al corregir campos en el Paso 3
  [
    [ownerNameInput, 'owner-name-error'],
    [ownerPhoneInput, 'owner-phone-error'],
    [ownerEmailInput, 'owner-email-error'],
    [petNameInput, 'pet-name-error'],
    [petAgeInput, 'pet-age-error'],
    [reasonNotesInput, 'reason-notes-error'],
  ].forEach(([inputEl, errorId]) => {
    if (!inputEl) return;
    inputEl.addEventListener('input', () => {
      if (inputEl.classList.contains('is-invalid')) {
        setFieldError(errorId, inputEl, '');
      }
    });
  });

  // Paso 4 -> Corregir / Confirmar
  if (btnStep4Back) {
    btnStep4Back.addEventListener('click', () => goToStep(3));
  }

  if (btnStep4Confirm) {
    btnStep4Confirm.addEventListener('click', handleConfirmAppointment);
  }

  // Acciones del comprobante final
  if (btnCopyFolio) {
    btnCopyFolio.addEventListener('click', async () => {
      const folio = state.createdAppointment?.folio || receiptFolioEl?.textContent || '';
      if (!folio) return;
      try {
        await navigator.clipboard.writeText(folio);
        if (copyFolioFeedback) {
          copyFolioFeedback.textContent = '¡Folio copiado!';
          copyFolioFeedback.classList.remove('d-none');
        }
      } catch {
        if (copyFolioFeedback) {
          copyFolioFeedback.textContent = 'Puede anotarlo o imprimir esta página.';
          copyFolioFeedback.classList.remove('d-none');
        }
      }
    });
  }

  if (btnPrintReceipt) {
    btnPrintReceipt.addEventListener('click', () => {
      if (!state.createdAppointment) {
        window.print();
        return;
      }
      printOfficialReceipt(
        {
          ...state.createdAppointment,
          serviceName:
            state.createdAppointment.serviceName || state.selectedService?.name || '',
          ownerName: state.createdAppointment.ownerName || state.formValues.ownerName,
          ownerPhone: state.createdAppointment.ownerPhone || state.formValues.ownerPhone,
          petName: state.createdAppointment.petName || state.formValues.petName,
          petSpecies: state.createdAppointment.petSpecies || state.formValues.petSpecies,
          petAge: state.createdAppointment.petAge || state.formValues.petAge,
          reasonNotes: state.createdAppointment.reasonNotes || state.formValues.reasonNotes,
        },
        state.config?.hospital || {}
      );
    });
  }

  if (btnBookAnother) {
    btnBookAnother.addEventListener('click', resetWizardForNewBooking);
  }

  // API pública del controlador del asistente para `app.js`
  return {
    setConfigLoading(isLoading) {
      if (servicesLoading) servicesLoading.classList.toggle('d-none', !isLoading);
      if (isLoading) {
        showAlert(servicesAlert, '');
      }
    },

    setConfig(configData) {
      state.config = configData || {};
      if (servicesLoading) servicesLoading.classList.add('d-none');

      // Configuramos los límites mínimo y máximo del selector de fechas
      const maxDays = Number(
        state.config?.maxDaysAhead ?? state.config?.hospital?.maxDaysAhead ?? 30
      );
      if (dateInput) {
        dateInput.min = getLocalIsoDate(0);
        dateInput.max = getLocalIsoDate(maxDays);
      }

      renderServices();
      renderSpeciesButtons();
      updateStepperUI();
    },

    setConfigError(message) {
      if (servicesLoading) servicesLoading.classList.add('d-none');
      if (!servicesAlert) return;

      servicesAlert.className = 'alert-box alert-box-danger';
      servicesAlert.replaceChildren(
        createEl('div', { className: 'd-flex flex-column gap-3' }, [
          createEl('div', { className: 'd-flex align-items-start gap-2' }, [
            createEl('i', { className: 'bi bi-wifi-off mt-1', 'aria-hidden': 'true' }),
            createEl('span', { text: message }),
          ]),
          createEl('div', {}, [
            createEl(
              'button',
              {
                type: 'button',
                className: 'btn btn-unam-primary btn-sm-senior',
                onClick: () => onRetryConfig(),
              },
              [
                createEl('i', { className: 'bi bi-arrow-clockwise me-2', 'aria-hidden': 'true' }),
                'Intentar de nuevo',
              ]
            ),
          ]),
        ])
      );
    },
  };
}
