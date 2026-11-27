/**
 * @file public/js/admin/schedule.js
 * @description Módulo de Horarios Semanales, Bloqueos de Fechas/Horarios y
 * Catálogo de Servicios (Pestaña 2) del Panel de Administrador Único.
 *
 * Sincronización inmediata:
 * Todos los cambios guardados aquí se persisten en SQLite (`schedule_rules`,
 * `blocked_dates`, `services`) y son consultados en tiempo real por la página
 * pública de citas (`/`).
 */

import {
  createEl,
  formatDateSpanish,
  formatTime12h,
  getLocalIsoDate,
} from '../shared/api.js';

/** Orden de presentación de Lunes (1) a Domingo (0) para lectura operativa natural. */
const DISPLAY_DAY_ORDER = Object.freeze([1, 2, 3, 4, 5, 6, 0]);

/** Etiquetas de días de la semana indexadas por `dayOfWeek` (0 = Domingo ... 6 = Sábado). */
const DAY_NAMES = Object.freeze({
  0: 'Domingo',
  1: 'Lunes',
  2: 'Martes',
  3: 'Miércoles',
  4: 'Jueves',
  5: 'Viernes',
  6: 'Sábado',
});

/** Duraciones de cita válidas permitidas por la restricción CHECK de `schedule_rules`. */
const VALID_SLOT_MINUTES = Object.freeze([15, 20, 30, 45, 60]);

/**
 * Normaliza una regla semanal proveniente del backend (camelCase o snake_case).
 * @param {object} raw
 */
function normalizeRule(raw) {
  return {
    dayOfWeek: Number(raw.dayOfWeek ?? raw.day_of_week ?? 0),
    isOpen: Boolean(raw.isOpen ?? raw.is_open),
    startTime: String(raw.startTime ?? raw.start_time ?? '09:00').slice(0, 5),
    endTime: String(raw.endTime ?? raw.end_time ?? '17:00').slice(0, 5),
    slotMinutes: Number(raw.slotMinutes ?? raw.slot_minutes ?? 30),
    capacityPerSlot: Number(raw.capacityPerSlot ?? raw.capacity_per_slot ?? 2),
  };
}

/**
 * Normaliza un bloqueo de fecha u horario.
 * @param {object} raw
 */
function normalizeBlock(raw) {
  return {
    id: raw.id,
    blockedDate: raw.blockedDate ?? raw.blocked_date ?? '',
    blockedTime: raw.blockedTime ?? raw.blocked_time ?? '',
    reason: raw.reason ?? '',
  };
}

/**
 * Normaliza un servicio del catálogo veterinario.
 * @param {object} raw
 */
function normalizeService(raw) {
  return {
    id: raw.id,
    name: raw.name ?? 'Servicio',
    description: raw.description ?? '',
    icon: raw.icon ?? 'bi-heart-pulse-fill',
    durationMinutes: Number(raw.durationMinutes ?? raw.duration_minutes ?? 30),
    active: Boolean(raw.active),
  };
}

/**
 * Valida que el nombre de clase de Bootstrap Icons contenga únicamente caracteres seguros.
 * @param {string} iconName
 * @returns {string}
 */
function safeBootstrapIcon(iconName) {
  return typeof iconName === 'string' && /^bi-[a-z0-9-]+$/i.test(iconName)
    ? iconName
    : 'bi-heart-pulse-fill';
}

/**
 * Inicializa el módulo de Horarios, Bloqueos y Servicios.
 *
 * @param {object} ctx
 * @param {Function} ctx.api - Cliente HTTP autenticado con control de sesión 401.
 * @param {Function} ctx.showToast - Muestra notificaciones Bootstrap Toast.
 * @param {Function} ctx.confirmAction - Abre diálogo de confirmación accesible.
 */
export function initSchedule(ctx) {
  const scheduleLoading = document.getElementById('scheduleLoading');

  // Referencias: Horario semanal
  const scheduleRulesForm = document.getElementById('scheduleRulesForm');
  const scheduleRulesBody = document.getElementById('scheduleRulesBody');
  const btnSaveScheduleRules = document.getElementById('btnSaveScheduleRules');

  // Referencias: Bloqueos
  const blockForm = document.getElementById('blockForm');
  const blockDateInput = document.getElementById('blockDate');
  const blockScopeFull = document.getElementById('blockScopeFull');
  const blockScopeTime = document.getElementById('blockScopeTime');
  const blockTimeGroup = document.getElementById('blockTimeGroup');
  const blockTimeInput = document.getElementById('blockTime');
  const blockReasonInput = document.getElementById('blockReason');
  const btnAddBlock = document.getElementById('btnAddBlock');
  const blocksEmpty = document.getElementById('blocksEmpty');
  const blocksTableWrap = document.getElementById('blocksTableWrap');
  const blocksListBody = document.getElementById('blocksListBody');

  // Referencias: Servicios
  const servicesEmpty = document.getElementById('servicesEmpty');
  const servicesList = document.getElementById('servicesList');

  // Valor mínimo de fecha para nuevos bloqueos: hoy
  blockDateInput.min = getLocalIsoDate(0);

  /**
   * Sincroniza la visibilidad del campo de hora específica según el alcance seleccionado.
   */
  function syncBlockScopeUi() {
    const isSpecificTime = blockScopeTime.checked;
    blockTimeGroup.classList.toggle('d-none', !isSpecificTime);
    blockTimeInput.required = isSpecificTime;
    if (!isSpecificTime) {
      blockTimeInput.value = '';
    }
  }

  /**
   * Renderiza la tabla editable del horario semanal (Lunes a Domingo).
   * @param {Array<object>} rules
   */
  function renderScheduleRules(rules) {
    scheduleRulesBody.replaceChildren();

    // Indexa reglas por dayOfWeek (0..6) y garantiza siempre los 7 días
    const byDay = new Map();
    for (const rule of rules) {
      byDay.set(rule.dayOfWeek, rule);
    }

    const fragment = document.createDocumentFragment();

    for (const dayOfWeek of DISPLAY_DAY_ORDER) {
      const rule = byDay.get(dayOfWeek) || {
        dayOfWeek,
        isOpen: false,
        startTime: '09:00',
        endTime: '17:00',
        slotMinutes: 30,
        capacityPerSlot: 2,
      };

      const switchId = `ruleOpen_${dayOfWeek}`;
      const statusLabel = createEl('label', {
        className: 'form-check-label small fw-semibold',
        for: switchId,
        text: rule.isOpen ? 'Abierto' : 'Cerrado',
      });

      const startInput = createEl('input', {
        type: 'time',
        className: 'form-control form-control-sm schedule-time-input',
        value: rule.startTime,
        disabled: !rule.isOpen,
        'aria-label': `Hora de inicio ${DAY_NAMES[dayOfWeek]}`,
        dataset: { field: 'startTime' },
      });

      const endInput = createEl('input', {
        type: 'time',
        className: 'form-control form-control-sm schedule-time-input',
        value: rule.endTime,
        disabled: !rule.isOpen,
        'aria-label': `Hora de cierre ${DAY_NAMES[dayOfWeek]}`,
        dataset: { field: 'endTime' },
      });

      const slotSelect = createEl(
        'select',
        {
          className: 'form-select form-select-sm',
          disabled: !rule.isOpen,
          'aria-label': `Duración de cita ${DAY_NAMES[dayOfWeek]}`,
          dataset: { field: 'slotMinutes' },
        },
        VALID_SLOT_MINUTES.map((mins) =>
          createEl('option', {
            value: String(mins),
            selected: rule.slotMinutes === mins,
            text: `${mins} min`,
          })
        )
      );

      const capacityInput = createEl('input', {
        type: 'number',
        className: 'form-control form-control-sm schedule-capacity-input',
        min: '1',
        max: '20',
        value: String(rule.capacityPerSlot),
        disabled: !rule.isOpen,
        'aria-label': `Cupos por horario ${DAY_NAMES[dayOfWeek]}`,
        dataset: { field: 'capacityPerSlot' },
      });

      const openSwitch = createEl('input', {
        type: 'checkbox',
        id: switchId,
        className: 'form-check-input',
        role: 'switch',
        checked: rule.isOpen,
        dataset: { field: 'isOpen' },
      });

      const row = createEl(
        'tr',
        {
          className: rule.isOpen ? '' : 'schedule-row-closed',
          dataset: { dayOfWeek: String(dayOfWeek) },
        },
        [
          createEl('td', { className: 'fw-semibold text-nowrap', text: DAY_NAMES[dayOfWeek] }),
          createEl('td', { className: 'text-nowrap' }, [
            createEl('div', { className: 'form-check form-switch mb-0' }, [
              openSwitch,
              statusLabel,
            ]),
          ]),
          createEl('td', {}, [startInput]),
          createEl('td', {}, [endInput]),
          createEl('td', {}, [slotSelect]),
          createEl('td', {}, [capacityInput]),
        ]
      );

      // Al alternar Abierto/Cerrado, habilita o deshabilita los controles de la fila
      openSwitch.addEventListener('change', () => {
        const opened = openSwitch.checked;
        statusLabel.textContent = opened ? 'Abierto' : 'Cerrado';
        row.classList.toggle('schedule-row-closed', !opened);
        startInput.disabled = !opened;
        endInput.disabled = !opened;
        slotSelect.disabled = !opened;
        capacityInput.disabled = !opened;
      });

      fragment.appendChild(row);
    }

    scheduleRulesBody.appendChild(fragment);
  }

  /**
   * Elimina un bloqueo vigente previa confirmación (`DELETE /api/admin/schedule/blocks/:id`).
   * @param {object} block
   */
  async function handleDeleteBlock(block) {
    const scopeText = block.blockedTime
      ? `el horario ${formatTime12h(block.blockedTime)}`
      : 'todo el día';
    const confirmed = await ctx.confirmAction({
      title: 'Eliminar bloqueo',
      message: `¿Deseas desbloquear ${scopeText} del ${formatDateSpanish(block.blockedDate)}? Volverá a mostrarse disponible en la página pública.`,
      confirmLabel: 'Sí, desbloquear',
      confirmVariant: 'primary',
    });
    if (!confirmed) return;

    try {
      await ctx.api(`/api/admin/schedule/blocks/${encodeURIComponent(block.id)}`, {
        method: 'DELETE',
        requiresCsrf: true,
      });
      ctx.showToast('Bloqueo eliminado. El horario se ha habilitado nuevamente.', 'success');
      await refresh();
    } catch (error) {
      if (!error.handledAuth) {
        ctx.showToast(error.message || 'No fue posible eliminar el bloqueo.', 'danger');
      }
    }
  }

  /**
   * Renderiza la tabla de días y horarios bloqueados vigentes.
   * @param {Array<object>} blocks
   */
  function renderBlockedDates(blocks) {
    blocksListBody.replaceChildren();

    if (!blocks.length) {
      blocksEmpty.classList.remove('d-none');
      blocksTableWrap.classList.add('d-none');
      return;
    }

    blocksEmpty.classList.add('d-none');
    blocksTableWrap.classList.remove('d-none');

    const fragment = document.createDocumentFragment();
    for (const block of blocks) {
      const isSpecificTime = Boolean(block.blockedTime);
      const scopeBadge = createEl('span', {
        className: isSpecificTime ? 'badge text-bg-warning' : 'badge text-bg-danger',
        text: isSpecificTime ? `${formatTime12h(block.blockedTime)} (${block.blockedTime})` : 'Todo el día',
      });

      const row = createEl('tr', {}, [
        createEl('td', {
          className: 'small fw-semibold',
          text: formatDateSpanish(block.blockedDate),
        }),
        createEl('td', { className: 'text-nowrap' }, [scopeBadge]),
        createEl('td', { className: 'small', text: block.reason || 'Sin motivo' }),
        createEl('td', { className: 'text-end text-nowrap' }, [
          createEl(
            'button',
            {
              type: 'button',
              className: 'btn btn-sm btn-outline-danger',
              onClick: () => handleDeleteBlock(block),
            },
            [
              createEl('i', { className: 'bi bi-unlock me-1', 'aria-hidden': 'true' }),
              'Desbloquear',
            ]
          ),
        ]),
      ]);

      fragment.appendChild(row);
    }

    blocksListBody.appendChild(fragment);
  }

  /**
   * Activa o desactiva un servicio veterinario (`PATCH /api/admin/services/:id`).
   * @param {object} service
   * @param {HTMLInputElement} switchEl
   * @param {HTMLElement} cardEl
   * @param {HTMLElement} stateTextEl
   */
  async function handleToggleService(service, switchEl, cardEl, stateTextEl) {
    const nextActive = switchEl.checked;
    switchEl.disabled = true;

    try {
      await ctx.api(`/api/admin/services/${encodeURIComponent(service.id)}`, {
        method: 'PATCH',
        requiresCsrf: true,
        body: { active: nextActive },
      });

      cardEl.classList.toggle('service-inactive', !nextActive);
      stateTextEl.textContent = nextActive ? 'Activo en página pública' : 'Inactivo';
      ctx.showToast(
        nextActive
          ? `Servicio "${service.name}" activado para citas públicas.`
          : `Servicio "${service.name}" pausado en la página pública.`,
        'success'
      );
    } catch (error) {
      // Revierte visualmente el interruptor si el backend rechazó el cambio
      switchEl.checked = !nextActive;
      if (!error.handledAuth) {
        ctx.showToast(error.message || 'No se pudo actualizar el estado del servicio.', 'danger');
      }
    } finally {
      switchEl.disabled = false;
    }
  }

  /**
   * Renderiza el catálogo de servicios con interruptores de activación.
   * @param {Array<object>} services
   */
  function renderServices(services) {
    servicesList.replaceChildren();

    if (!services.length) {
      servicesEmpty.classList.remove('d-none');
      return;
    }
    servicesEmpty.classList.add('d-none');

    const fragment = document.createDocumentFragment();
    for (const service of services) {
      const switchId = `serviceSwitch_${service.id}`;
      const stateTextEl = createEl('label', {
        className: 'form-check-label small fw-semibold',
        for: switchId,
        text: service.active ? 'Activo en página pública' : 'Inactivo',
      });

      const switchEl = createEl('input', {
        type: 'checkbox',
        id: switchId,
        className: 'form-check-input',
        role: 'switch',
        checked: service.active,
      });

      const cardEl = createEl(
        'div',
        {
          className: `service-admin-card ${service.active ? '' : 'service-inactive'}`,
        },
        [
          createEl('div', { className: 'd-flex align-items-start gap-3' }, [
            createEl('div', { className: 'service-icon-box', 'aria-hidden': 'true' }, [
              createEl('i', { className: `bi ${safeBootstrapIcon(service.icon)}` }),
            ]),
            createEl('div', { className: 'flex-grow-1' }, [
              createEl('div', { className: 'd-flex flex-wrap justify-content-between align-items-center gap-2 mb-1' }, [
                createEl('span', { className: 'fw-bold text-unam-navy', text: service.name }),
                createEl('span', {
                  className: 'badge text-bg-light border',
                  text: `${service.durationMinutes} min`,
                }),
              ]),
              createEl('p', { className: 'small text-muted mb-2', text: service.description }),
              createEl('div', { className: 'form-check form-switch mb-0' }, [
                switchEl,
                stateTextEl,
              ]),
            ]),
          ]),
        ]
      );

      switchEl.addEventListener('change', () => {
        handleToggleService(service, switchEl, cardEl, stateTextEl);
      });

      fragment.appendChild(cardEl);
    }

    servicesList.appendChild(fragment);
  }

  /**
   * Carga desde el backend las reglas semanales, bloqueos vigentes y catálogo de servicios.
   */
  async function refresh() {
    scheduleLoading.classList.remove('d-none');
    try {
      const response = await ctx.api('/api/admin/schedule');
      const data = response.data || {};

      const rules = (Array.isArray(data.rules) ? data.rules : []).map(normalizeRule);
      const blocks = (Array.isArray(data.blockedDates) ? data.blockedDates : []).map(
        normalizeBlock
      );
      const services = (Array.isArray(data.services) ? data.services : []).map(normalizeService);

      renderScheduleRules(rules);
      renderBlockedDates(blocks);
      renderServices(services);
    } catch (error) {
      if (!error.handledAuth) {
        ctx.showToast(
          error.message || 'No se pudo cargar la configuración de horarios y servicios.',
          'danger'
        );
      }
    } finally {
      scheduleLoading.classList.add('d-none');
    }
  }

  /**
   * Valida y guarda las 7 reglas de horario semanal (`PUT /api/admin/schedule/rules`).
   * @param {SubmitEvent} event
   */
  async function handleSaveScheduleRules(event) {
    event.preventDefault();

    const rows = Array.from(scheduleRulesBody.querySelectorAll('tr[data-day-of-week]'));
    const rulesPayload = [];

    for (const row of rows) {
      const dayOfWeek = Number(row.dataset.dayOfWeek);
      const isOpen = row.querySelector('[data-field="isOpen"]').checked;
      const startTime = row.querySelector('[data-field="startTime"]').value.slice(0, 5);
      const endTime = row.querySelector('[data-field="endTime"]').value.slice(0, 5);
      const slotMinutes = Number(row.querySelector('[data-field="slotMinutes"]').value);
      const capacityPerSlot = Number(row.querySelector('[data-field="capacityPerSlot"]').value);

      if (isOpen) {
        if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) {
          ctx.showToast(
            `Verifica las horas de inicio y fin para ${DAY_NAMES[dayOfWeek]}.`,
            'warning'
          );
          return;
        }
        if (startTime >= endTime) {
          ctx.showToast(
            `En ${DAY_NAMES[dayOfWeek]}, la hora de cierre debe ser posterior a la hora de inicio.`,
            'warning'
          );
          return;
        }
        if (!Number.isInteger(capacityPerSlot) || capacityPerSlot < 1 || capacityPerSlot > 20) {
          ctx.showToast(
            `Los cupos por horario en ${DAY_NAMES[dayOfWeek]} deben estar entre 1 y 20.`,
            'warning'
          );
          return;
        }
      }

      rulesPayload.push({
        dayOfWeek,
        isOpen,
        startTime: startTime || '09:00',
        endTime: endTime || '17:00',
        slotMinutes: VALID_SLOT_MINUTES.includes(slotMinutes) ? slotMinutes : 30,
        capacityPerSlot: Math.min(20, Math.max(1, Number.isFinite(capacityPerSlot) ? capacityPerSlot : 2)),
      });
    }

    // Ordena 0..6 antes de enviar al servidor para mantener consistencia
    rulesPayload.sort((a, b) => a.dayOfWeek - b.dayOfWeek);

    btnSaveScheduleRules.disabled = true;
    try {
      const response = await ctx.api('/api/admin/schedule/rules', {
        method: 'PUT',
        requiresCsrf: true,
        body: { rules: rulesPayload },
      });
      ctx.showToast(
        response.message ||
          'Horarios guardados. La disponibilidad pública ya está actualizada.',
        'success'
      );
      await refresh();
    } catch (error) {
      if (!error.handledAuth) {
        ctx.showToast(error.message || 'No fue posible guardar los horarios.', 'danger');
      }
    } finally {
      btnSaveScheduleRules.disabled = false;
    }
  }

  /**
   * Registra un nuevo bloqueo de día completo u horario específico (`POST /api/admin/schedule/blocks`).
   * @param {SubmitEvent} event
   */
  async function handleAddBlock(event) {
    event.preventDefault();

    const blockedDate = blockDateInput.value.trim();
    const isSpecificTime = blockScopeTime.checked;
    const blockedTime = isSpecificTime ? blockTimeInput.value.trim().slice(0, 5) : '';
    const reason = blockReasonInput.value.trim();

    if (!blockedDate || !/^\d{4}-\d{2}-\d{2}$/.test(blockedDate)) {
      ctx.showToast('Selecciona una fecha válida para bloquear.', 'warning');
      blockDateInput.focus();
      return;
    }

    if (isSpecificTime && (!blockedTime || !/^\d{2}:\d{2}$/.test(blockedTime))) {
      ctx.showToast('Indica la hora exacta (HH:MM) que deseas bloquear.', 'warning');
      blockTimeInput.focus();
      return;
    }

    if (reason.length < 3) {
      ctx.showToast('Escribe un motivo claro del bloqueo (mínimo 3 caracteres).', 'warning');
      blockReasonInput.focus();
      return;
    }

    const payload = { blockedDate, reason };
    if (isSpecificTime) {
      payload.blockedTime = blockedTime;
    }

    btnAddBlock.disabled = true;
    try {
      await ctx.api('/api/admin/schedule/blocks', {
        method: 'POST',
        requiresCsrf: true,
        body: payload,
      });

      blockForm.reset();
      blockScopeFull.checked = true;
      syncBlockScopeUi();
      ctx.showToast(
        'Bloqueo registrado correctamente. Ya no se podrán agendar citas en ese espacio.',
        'success'
      );
      await refresh();
    } catch (error) {
      if (!error.handledAuth) {
        ctx.showToast(error.message || 'No fue posible registrar el bloqueo.', 'danger');
      }
    } finally {
      btnAddBlock.disabled = false;
    }
  }

  // Enlace de eventos
  blockScopeFull.addEventListener('change', syncBlockScopeUi);
  blockScopeTime.addEventListener('change', syncBlockScopeUi);
  scheduleRulesForm.addEventListener('submit', handleSaveScheduleRules);
  blockForm.addEventListener('submit', handleAddBlock);

  syncBlockScopeUi();

  return {
    refresh,
  };
}
