/**
 * @file public/js/admin/appointments.js
 * @description Módulo de gestión de Agenda y Citas (Pestaña 1) del Panel de
 * Administrador Único del Hospital de Pequeñas Especies (UNAM FES Cuautitlán).
 *
 * Funcionalidades:
 * - Indicadores KPI del día seleccionado (Total, Pendientes, Confirmadas, Atendidas, Canceladas).
 * - Filtros combinables: fecha (con accesos rápidos "Hoy" y "Todas las fechas"), estado y búsqueda.
 * - Tabla responsiva segura (construida con `createEl` y `textContent`, sin `innerHTML`).
 * - Acciones rápidas por fila: Confirmar, Marcar atendida, Cancelar y Ver / Reagendar.
 * - Modal completo de detalles, reagendamiento con vista de horarios disponibles y notas internas.
 * - Impresión limpia de la agenda del día (`window.print()`).
 */

import {
  STATUS_META,
  createEl,
  formatDateSpanish,
  formatTime12h,
  getLocalIsoDate,
} from '../shared/api.js';

/**
 * Normaliza un objeto de cita proveniente del backend soportando tanto camelCase
 * como snake_case para garantizar resiliencia ante variaciones menores del serializer.
 * @param {object} raw
 */
function normalizeAppointment(raw) {
  return {
    id: raw.id,
    folio: raw.folio ?? '',
    serviceId: raw.serviceId ?? raw.service_id ?? null,
    serviceName: raw.serviceName ?? raw.service_name ?? 'Servicio veterinario',
    date: raw.date ?? raw.appointmentDate ?? raw.appointment_date ?? '',
    time: raw.time ?? raw.appointmentTime ?? raw.appointment_time ?? '',
    ownerName: raw.ownerName ?? raw.owner_name ?? '',
    ownerPhone: raw.ownerPhone ?? raw.owner_phone ?? '',
    ownerEmail: raw.ownerEmail ?? raw.owner_email ?? '',
    petName: raw.petName ?? raw.pet_name ?? '',
    petSpecies: raw.petSpecies ?? raw.pet_species ?? '',
    petAge: raw.petAge ?? raw.pet_age ?? '',
    reasonNotes: raw.reasonNotes ?? raw.reason_notes ?? '',
    status: raw.status ?? 'pendiente',
    adminNotes: raw.adminNotes ?? raw.admin_notes ?? '',
    createdAt: raw.createdAt ?? raw.created_at ?? '',
  };
}

/**
 * Calcula los contadores KPI a partir de una lista de citas (usado en modo "Todas las fechas").
 * @param {Array<object>} list
 */
function computeStatsFromList(list) {
  const stats = {
    total: list.length,
    pendiente: 0,
    confirmada: 0,
    atendida: 0,
    cancelada: 0,
  };
  for (const appt of list) {
    if (Object.prototype.hasOwnProperty.call(stats, appt.status)) {
      stats[appt.status] += 1;
    }
  }
  return stats;
}

/**
 * Formatea una fecha corta en español para la tabla de citas ('27 nov 2026').
 * @param {string} isoDate
 * @returns {string}
 */
function formatShortDate(isoDate) {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate || '—';
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Intl.DateTimeFormat('es-MX', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(year, month - 1, day));
}

/**
 * Formatea una marca temporal de creación para el modal de detalles.
 * @param {string} rawDate
 * @returns {string}
 */
function formatCreatedAt(rawDate) {
  if (!rawDate) return '—';
  const normalized =
    typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rawDate)
      ? `${rawDate.replace(' ', 'T')}Z`
      : rawDate;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return String(rawDate);
  return new Intl.DateTimeFormat('es-MX', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}

/**
 * Inicializa el módulo de gestión de citas y agenda diaria.
 *
 * @param {object} ctx
 * @param {Function} ctx.api - Wrapper de `apiRequest` con manejo global de 401.
 * @param {Function} ctx.showToast - Muestra notificaciones Bootstrap Toast.
 * @param {Function} ctx.confirmAction - Abre modal accesible de confirmación.
 */
export function initAppointments(ctx) {
  // Referencias de KPIs y encabezados
  const kpiSubtitle = document.getElementById('kpiSubtitle');
  const kpiTotal = document.getElementById('kpiTotal');
  const kpiPendiente = document.getElementById('kpiPendiente');
  const kpiConfirmada = document.getElementById('kpiConfirmada');
  const kpiAtendida = document.getElementById('kpiAtendida');
  const kpiCancelada = document.getElementById('kpiCancelada');
  const printHeaderDate = document.getElementById('printHeaderDate');
  const printHeaderGenerated = document.getElementById('printHeaderGenerated');

  // Referencias de filtros y botones
  const filterDate = document.getElementById('filterDate');
  const btnFilterToday = document.getElementById('btnFilterToday');
  const btnFilterAllDates = document.getElementById('btnFilterAllDates');
  const filterStatus = document.getElementById('filterStatus');
  const filterSearch = document.getElementById('filterSearch');
  const btnClearSearch = document.getElementById('btnClearSearch');
  const btnRefreshAppointments = document.getElementById('btnRefreshAppointments');
  const btnPrintAgenda = document.getElementById('btnPrintAgenda');

  // Referencias de tabla
  const appointmentsCountLabel = document.getElementById('appointmentsCountLabel');
  const appointmentsLoading = document.getElementById('appointmentsLoading');
  const appointmentsEmpty = document.getElementById('appointmentsEmpty');
  const appointmentsTableWrap = document.getElementById('appointmentsTableWrap');
  const appointmentsTableBody = document.getElementById('appointmentsTableBody');

  // Referencias del Modal de Detalles / Reagendar
  const modalElement = document.getElementById('appointmentDetailModal');
  const detailModal = new window.bootstrap.Modal(modalElement);
  const modalApptFolio = document.getElementById('modalApptFolio');
  const modalApptStatusBadge = document.getElementById('modalApptStatusBadge');
  const modalDetailPet = document.getElementById('modalDetailPet');
  const modalDetailSpeciesAge = document.getElementById('modalDetailSpeciesAge');
  const modalDetailService = document.getElementById('modalDetailService');
  const modalDetailReason = document.getElementById('modalDetailReason');
  const modalDetailOwner = document.getElementById('modalDetailOwner');
  const modalDetailPhone = document.getElementById('modalDetailPhone');
  const modalDetailEmail = document.getElementById('modalDetailEmail');
  const modalDetailCreated = document.getElementById('modalDetailCreated');

  const appointmentEditForm = document.getElementById('appointmentEditForm');
  const editApptId = document.getElementById('editApptId');
  const editApptDate = document.getElementById('editApptDate');
  const editApptTime = document.getElementById('editApptTime');
  const editApptSlotsHelp = document.getElementById('editApptSlotsHelp');
  const editApptSlotsList = document.getElementById('editApptSlotsList');
  const editApptStatus = document.getElementById('editApptStatus');
  const editApptNotes = document.getElementById('editApptNotes');
  const editApptError = document.getElementById('editApptError');
  const btnSaveAppointment = document.getElementById('btnSaveAppointment');

  // Estado local de filtros y cita seleccionada
  let selectedDate = getLocalIsoDate(0);
  let searchDebounceId = null;
  let currentModalAppointment = null;

  filterDate.value = selectedDate;

  /**
   * Actualiza los estilos activos de los botones rápidos "Hoy" y "Todas las fechas".
   */
  function syncDateQuickButtons() {
    const today = getLocalIsoDate(0);
    const isToday = selectedDate === today;
    const isAllDates = selectedDate === '';

    btnFilterToday.classList.toggle('btn-primary', isToday);
    btnFilterToday.classList.toggle('btn-outline-primary', !isToday);

    btnFilterAllDates.classList.toggle('btn-secondary', isAllDates);
    btnFilterAllDates.classList.toggle('btn-outline-secondary', !isAllDates);
  }

  /**
   * Actualiza los 5 indicadores KPI y el subtítulo de la fecha mostrada.
   * @param {{ total?: number, pendiente?: number, confirmada?: number, atendida?: number, cancelada?: number }} stats
   */
  function renderKpis(stats) {
    kpiTotal.textContent = String(stats.total ?? 0);
    kpiPendiente.textContent = String(stats.pendiente ?? 0);
    kpiConfirmada.textContent = String(stats.confirmada ?? 0);
    kpiAtendida.textContent = String(stats.atendida ?? 0);
    kpiCancelada.textContent = String(stats.cancelada ?? 0);

    if (selectedDate) {
      kpiSubtitle.textContent = `Resumen del día: ${formatDateSpanish(selectedDate)}`;
    } else {
      kpiSubtitle.textContent = 'Mostrando todas las fechas registradas (indicadores según filtro actual)';
    }
  }

  /**
   * Ejecuta un cambio rápido de estado desde los botones de la fila.
   * @param {object} appt
   * @param {'confirmada'|'atendida'|'cancelada'} targetStatus
   */
  async function handleQuickStatusChange(appt, targetStatus) {
    if (targetStatus === 'cancelada') {
      const confirmed = await ctx.confirmAction({
        title: 'Cancelar cita',
        message: `¿Confirmas cancelar la cita ${appt.folio} de ${appt.petName} (${appt.ownerName})? Esto liberará automáticamente el horario en la página pública.`,
        confirmLabel: 'Sí, cancelar cita',
        confirmVariant: 'danger',
      });
      if (!confirmed) return;
    }

    try {
      await ctx.api(`/api/admin/appointments/${encodeURIComponent(appt.id)}`, {
        method: 'PATCH',
        requiresCsrf: true,
        body: { status: targetStatus },
      });

      const statusLabel = STATUS_META[targetStatus]?.shortLabel || targetStatus;
      ctx.showToast(`Cita ${appt.folio} marcada como "${statusLabel}".`, 'success');
      await refresh();
    } catch (error) {
      if (!error.handledAuth) {
        ctx.showToast(error.message || 'No se pudo actualizar el estado de la cita.', 'danger');
      }
    }
  }

  /**
   * Consulta los horarios disponibles de una fecha para ayudar al administrador al reagendar.
   * @param {string} isoDate
   */
  async function loadAvailableSlotsForModal(isoDate) {
    editApptSlotsList.replaceChildren();
    if (!isoDate) {
      editApptSlotsHelp.textContent = 'Selecciona una fecha para consultar disponibilidad.';
      return;
    }

    editApptSlotsHelp.textContent = 'Consultando horarios disponibles...';
    try {
      const response = await ctx.api(`/api/public/availability?date=${encodeURIComponent(isoDate)}`);
      const data = response.data || {};

      if (data.dayBlocked) {
        editApptSlotsHelp.textContent = `Día bloqueado: ${data.blockReason || 'Sin atención'}.`;
        return;
      }
      if (data.isOpen === false) {
        editApptSlotsHelp.textContent = 'El hospital está cerrado este día según el horario semanal.';
        return;
      }

      const slots = Array.isArray(data.slots) ? data.slots : [];
      if (!slots.length) {
        editApptSlotsHelp.textContent = 'No hay bloques horarios configurados para esta fecha.';
        return;
      }

      editApptSlotsHelp.textContent =
        'Haz clic en un horario disponible para asignarlo automáticamente:';

      const fragment = document.createDocumentFragment();
      for (const slot of slots) {
        const isCurrentSlot =
          currentModalAppointment &&
          currentModalAppointment.date === isoDate &&
          currentModalAppointment.time === slot.time;
        const canSelect = Boolean(slot.isAvailable) || isCurrentSlot;

        const btn = createEl('button', {
          type: 'button',
          className: `btn slot-suggestion-btn ${
            editApptTime.value === slot.time
              ? 'btn-unam-navy'
              : canSelect
                ? 'btn-outline-primary'
                : 'btn-outline-secondary'
          }`,
          disabled: !canSelect,
          text: `${formatTime12h(slot.time)} (${slot.available ?? 0}/${slot.capacity ?? 0})`,
          title: canSelect ? `Seleccionar ${slot.time}` : slot.reason || 'Sin cupo disponible',
          onClick: () => {
            editApptTime.value = slot.time;
            // Resalta el botón recién elegido
            for (const sibling of editApptSlotsList.querySelectorAll('button')) {
              sibling.classList.remove('btn-unam-navy');
              if (!sibling.disabled) {
                sibling.classList.add('btn-outline-primary');
              }
            }
            btn.classList.remove('btn-outline-primary');
            btn.classList.add('btn-unam-navy');
          },
        });
        fragment.appendChild(btn);
      }

      editApptSlotsList.appendChild(fragment);
    } catch {
      editApptSlotsHelp.textContent =
        'No se pudieron cargar las sugerencias de horario; puedes escribir la hora manualmente (HH:MM).';
    }
  }

  /**
   * Abre el modal con todos los datos de la cita para consultar, reagendar o agregar notas internas.
   * @param {object} appt
   */
  function openDetailModal(appt) {
    currentModalAppointment = appt;
    editApptError.classList.add('d-none');
    editApptError.textContent = '';

    const statusInfo = STATUS_META[appt.status] || {
      shortLabel: appt.status,
      badgeClass: 'text-bg-secondary',
    };

    modalApptFolio.textContent = appt.folio;
    modalApptStatusBadge.className = `badge ms-1 ${statusInfo.badgeClass}`;
    modalApptStatusBadge.textContent = statusInfo.shortLabel;

    modalDetailPet.textContent = appt.petName || '—';
    modalDetailSpeciesAge.textContent = appt.petAge
      ? `${appt.petSpecies || 'Sin especie'} · ${appt.petAge}`
      : appt.petSpecies || '—';
    modalDetailService.textContent = appt.serviceName || '—';
    modalDetailReason.textContent = appt.reasonNotes || 'Sin motivo especificado.';

    modalDetailOwner.textContent = appt.ownerName || '—';
    modalDetailPhone.textContent = appt.ownerPhone || '—';
    modalDetailEmail.textContent = appt.ownerEmail || 'No proporcionado';
    modalDetailCreated.textContent = formatCreatedAt(appt.createdAt);

    editApptId.value = String(appt.id);
    editApptDate.value = appt.date;
    editApptTime.value = appt.time;
    editApptStatus.value = appt.status;
    editApptNotes.value = appt.adminNotes || '';

    detailModal.show();
    loadAvailableSlotsForModal(appt.date);
  }

  /**
   * Construye y renderiza las filas de citas en la tabla usando solo `createEl` y `textContent`.
   * @param {Array<object>} appointments
   */
  function renderTable(appointments) {
    appointmentsTableBody.replaceChildren();
    appointmentsCountLabel.textContent = `${appointments.length} ${
      appointments.length === 1 ? 'cita' : 'citas'
    }`;

    if (!appointments.length) {
      appointmentsEmpty.classList.remove('d-none');
      appointmentsTableWrap.classList.add('d-none');
      return;
    }

    appointmentsEmpty.classList.add('d-none');
    appointmentsTableWrap.classList.remove('d-none');

    const fragment = document.createDocumentFragment();

    for (const appt of appointments) {
      const statusMeta = STATUS_META[appt.status] || {
        shortLabel: appt.status,
        badgeClass: 'text-bg-secondary',
      };

      // Botones de acciones rápidas según estado actual de la cita
      const actionButtons = [];

      if (appt.status === 'pendiente') {
        actionButtons.push(
          createEl(
            'button',
            {
              type: 'button',
              className: 'btn btn-sm btn-outline-success',
              title: 'Confirmar cita',
              onClick: () => handleQuickStatusChange(appt, 'confirmada'),
            },
            [createEl('i', { className: 'bi bi-check-lg me-1', 'aria-hidden': 'true' }), 'Confirmar']
          )
        );
      }

      if (appt.status === 'pendiente' || appt.status === 'confirmada') {
        actionButtons.push(
          createEl(
            'button',
            {
              type: 'button',
              className: 'btn btn-sm btn-outline-primary',
              title: 'Marcar como atendida',
              onClick: () => handleQuickStatusChange(appt, 'atendida'),
            },
            [createEl('i', { className: 'bi bi-heart-pulse me-1', 'aria-hidden': 'true' }), 'Atendida']
          )
        );
      }

      if (appt.status !== 'cancelada' && appt.status !== 'atendida') {
        actionButtons.push(
          createEl(
            'button',
            {
              type: 'button',
              className: 'btn btn-sm btn-outline-danger',
              title: 'Cancelar cita',
              onClick: () => handleQuickStatusChange(appt, 'cancelada'),
            },
            [createEl('i', { className: 'bi bi-x-lg me-1', 'aria-hidden': 'true' }), 'Cancelar']
          )
        );
      }

      actionButtons.push(
        createEl(
          'button',
          {
            type: 'button',
            className: 'btn btn-sm btn-unam-navy',
            title: 'Ver detalles completos, reagendar o agregar notas',
            onClick: () => openDetailModal(appt),
          },
          [
            createEl('i', { className: 'bi bi-pencil-square me-1', 'aria-hidden': 'true' }),
            'Ver / Reagendar',
          ]
        )
      );

      const petSubtitle = appt.petAge
        ? `${appt.petSpecies} · ${appt.petAge}`
        : appt.petSpecies || 'Pequeña especie';

      const row = createEl('tr', {}, [
        // 1. Fecha y hora
        createEl('td', { className: 'text-nowrap' }, [
          createEl('div', { className: 'fw-semibold', text: formatTime12h(appt.time) }),
          createEl('div', {
            className: 'small text-muted',
            text: `${formatShortDate(appt.date)} (${appt.time})`,
          }),
        ]),
        // 2. Folio
        createEl('td', { className: 'text-nowrap' }, [
          createEl('span', { className: 'folio-chip', text: appt.folio }),
        ]),
        // 3. Mascota y especie
        createEl('td', {}, [
          createEl('div', { className: 'fw-semibold', text: appt.petName }),
          createEl('div', { className: 'small text-muted', text: petSubtitle }),
        ]),
        // 4. Tutor y teléfono
        createEl('td', {}, [
          createEl('div', { className: 'fw-semibold', text: appt.ownerName }),
          createEl('div', { className: 'small text-muted' }, [
            createEl('i', { className: 'bi bi-telephone me-1', 'aria-hidden': 'true' }),
            appt.ownerPhone || '—',
          ]),
        ]),
        // 5. Servicio
        createEl('td', {}, [
          createEl('div', { className: 'small fw-semibold', text: appt.serviceName }),
          appt.adminNotes
            ? createEl('div', {
                className: 'small text-muted',
                text: 'Con nota interna',
              })
            : null,
        ]),
        // 6. Estado
        createEl('td', { className: 'text-nowrap' }, [
          createEl('span', {
            className: `badge ${statusMeta.badgeClass}`,
            text: statusMeta.shortLabel,
          }),
        ]),
        // 7. Acciones
        createEl('td', { className: 'text-end no-print' }, [
          createEl('div', { className: 'action-btn-group' }, actionButtons),
        ]),
      ]);

      fragment.appendChild(row);
    }

    appointmentsTableBody.appendChild(fragment);
  }

  /**
   * Consulta KPIs y listado de citas aplicando los filtros activos.
   */
  async function refresh() {
    syncDateQuickButtons();

    appointmentsLoading.classList.remove('d-none');
    appointmentsEmpty.classList.add('d-none');
    appointmentsTableWrap.classList.add('d-none');
    btnRefreshAppointments.disabled = true;

    const statusVal = filterStatus.value.trim();
    const searchVal = filterSearch.value.trim();

    try {
      const params = new URLSearchParams();
      if (selectedDate) params.set('date', selectedDate);
      if (statusVal) params.set('status', statusVal);
      if (searchVal) params.set('search', searchVal);

      if (selectedDate) {
        // Cuando hay una fecha seleccionada, consultamos los KPIs oficiales del día y la lista filtrada en paralelo
        const [dashboardRes, listRes] = await Promise.all([
          ctx.api(`/api/admin/dashboard?date=${encodeURIComponent(selectedDate)}`),
          statusVal || searchVal
            ? ctx.api(`/api/admin/appointments?${params.toString()}`)
            : Promise.resolve(null),
        ]);

        const dashboardData = dashboardRes.data || {};
        const rawList = listRes
          ? Array.isArray(listRes.data)
            ? listRes.data
            : listRes.data?.appointments || []
          : Array.isArray(dashboardData.appointments)
            ? dashboardData.appointments
            : [];

        const normalizedList = rawList.map(normalizeAppointment);
        const stats = dashboardData.stats || computeStatsFromList(normalizedList);

        renderKpis(stats);
        renderTable(normalizedList);
      } else {
        // Modo "Todas las fechas": listamos con los filtros activos y calculamos los KPIs mostrados
        const queryStr = params.toString();
        const listRes = await ctx.api(
          queryStr ? `/api/admin/appointments?${queryStr}` : '/api/admin/appointments'
        );
        const rawList = Array.isArray(listRes.data)
          ? listRes.data
          : listRes.data?.appointments || [];
        const normalizedList = rawList.map(normalizeAppointment);

        renderKpis(computeStatsFromList(normalizedList));
        renderTable(normalizedList);
      }
    } catch (error) {
      if (!error.handledAuth) {
        ctx.showToast(error.message || 'No fue posible cargar la agenda de citas.', 'danger');
        appointmentsEmpty.classList.remove('d-none');
      }
    } finally {
      appointmentsLoading.classList.add('d-none');
      btnRefreshAppointments.disabled = false;
    }
  }

  /**
   * Guarda los cambios de reagendamiento, estado y notas internas desde el modal.
   * @param {SubmitEvent} event
   */
  async function handleSaveAppointment(event) {
    event.preventDefault();
    editApptError.classList.add('d-none');
    editApptError.textContent = '';

    const id = editApptId.value;
    const date = editApptDate.value.trim();
    const time = editApptTime.value.trim().slice(0, 5);
    const status = editApptStatus.value;
    const adminNotes = editApptNotes.value.trim();

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      editApptError.textContent = 'Selecciona una fecha válida (AAAA-MM-DD).';
      editApptError.classList.remove('d-none');
      return;
    }

    if (!time || !/^\d{2}:\d{2}$/.test(time)) {
      editApptError.textContent = 'Selecciona una hora válida en formato HH:MM.';
      editApptError.classList.remove('d-none');
      return;
    }

    btnSaveAppointment.disabled = true;
    try {
      await ctx.api(`/api/admin/appointments/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        requiresCsrf: true,
        body: {
          date,
          time,
          status,
          adminNotes,
        },
      });

      detailModal.hide();
      ctx.showToast('Cambios de la cita guardados correctamente.', 'success');
      await refresh();
    } catch (error) {
      if (!error.handledAuth) {
        editApptError.textContent =
          error.message || 'No se pudieron guardar los cambios. Revisa la disponibilidad del horario.';
        editApptError.classList.remove('d-none');
      }
    } finally {
      btnSaveAppointment.disabled = false;
    }
  }

  /**
   * Prepara el encabezado de impresión y abre el diálogo nativo del navegador.
   */
  function handlePrintAgenda() {
    printHeaderDate.textContent = selectedDate
      ? formatDateSpanish(selectedDate)
      : 'Todas las fechas registradas';
    printHeaderGenerated.textContent = new Intl.DateTimeFormat('es-MX', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date());
    window.print();
  }

  // Enlace de filtros y controles
  filterDate.addEventListener('change', () => {
    selectedDate = filterDate.value;
    refresh();
  });

  btnFilterToday.addEventListener('click', () => {
    selectedDate = getLocalIsoDate(0);
    filterDate.value = selectedDate;
    refresh();
  });

  btnFilterAllDates.addEventListener('click', () => {
    selectedDate = '';
    filterDate.value = '';
    refresh();
  });

  filterStatus.addEventListener('change', () => {
    refresh();
  });

  filterSearch.addEventListener('input', () => {
    btnClearSearch.classList.toggle('d-none', !filterSearch.value);
    if (searchDebounceId !== null) {
      window.clearTimeout(searchDebounceId);
    }
    searchDebounceId = window.setTimeout(() => {
      refresh();
    }, 320);
  });

  filterSearch.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (searchDebounceId !== null) {
        window.clearTimeout(searchDebounceId);
      }
      refresh();
    }
  });

  btnClearSearch.addEventListener('click', () => {
    filterSearch.value = '';
    btnClearSearch.classList.add('d-none');
    refresh();
    filterSearch.focus();
  });

  btnRefreshAppointments.addEventListener('click', () => {
    refresh();
  });

  btnPrintAgenda.addEventListener('click', handlePrintAgenda);

  editApptDate.addEventListener('change', () => {
    loadAvailableSlotsForModal(editApptDate.value);
  });

  appointmentEditForm.addEventListener('submit', handleSaveAppointment);

  return {
    refresh,
    closeModals: () => detailModal.hide(),
  };
}
