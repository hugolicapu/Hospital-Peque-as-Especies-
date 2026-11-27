/**
 * @file public/js/citas/receipt.js
 * @description Generador del Comprobante Oficial en PDF / Impresión del
 * Hospital de Pequeñas Especies · UNAM FES Cuautitlán (Campo 4).
 *
 * Cómo funciona:
 * - Rellena una hoja dedicada de 1 página (`#official-pdf-sheet`) diseñada
 *   exclusivamente en colores institucionales UNAM (Azul #002B5C, Oro #C59B27
 *   y Blanco #FFFFFF) sin duplicar encabezados ni formularios de pantalla.
 * - Ajusta temporalmente `document.title` al folio (`Comprobante-Cita-FESC-...`)
 *   para que al elegir "Guardar como PDF" en el navegador el archivo reciba
 *   automáticamente el nombre oficial del folio.
 * - Usa exclusivamente `createEl` y `textContent` (cero `innerHTML`).
 */

import {
  createEl,
  formatDateSpanish,
  formatTime12h,
  STATUS_META,
} from '../shared/api.js';

/**
 * Formatea la fecha y hora actual de emisión del comprobante en español de México.
 * @returns {string}
 */
export function formatIssuedTimestamp() {
  return new Intl.DateTimeFormat('es-MX', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date());
}

/**
 * Crea una fila limpia de tabla para la hoja oficial de PDF.
 * @param {string} label
 * @param {string} value
 */
function createPdfRow(label, value) {
  return createEl('tr', {}, [
    createEl('th', { scope: 'row', className: 'pdf-detail-key', text: label }),
    createEl('td', { className: 'pdf-detail-val', text: value || '—' }),
  ]);
}

/**
 * Rellena la hoja oficial oculta `#official-pdf-sheet` para que esté lista tanto al
 * pulsar el botón "Guardar en PDF / Imprimir" como si el usuario presiona Ctrl+P.
 *
 * @param {object} appointment
 * @param {object} [hospitalInfo={}]
 * @returns {string} Folio limpio de la cita.
 */
export function populateOfficialReceipt(appointment, hospitalInfo = {}) {
  const sheet = document.getElementById('official-pdf-sheet');
  if (!sheet || !appointment) return '';

  const hospital = hospitalInfo || {};
  const folio = appointment.folio || 'SIN-FOLIO';
  const serviceName = appointment.serviceName || appointment.service_name || 'Consulta veterinaria';
  const dateVal = appointment.date || appointment.appointment_date || '';
  const timeVal = appointment.time || appointment.appointment_time || '';
  const ownerName = appointment.ownerName || appointment.owner_name || '—';
  const ownerPhone = appointment.ownerPhone || appointment.owner_phone || '—';
  const petName = appointment.petName || appointment.pet_name || '—';
  const petSpecies = appointment.petSpecies || appointment.pet_species || '';
  const petAge = appointment.petAge || appointment.pet_age || '';
  const reasonNotes = appointment.reasonNotes || appointment.reason_notes || '';
  const statusKey = appointment.status || 'pendiente';
  const statusLabel = STATUS_META[statusKey]?.label || statusKey;
  const arrivalMinutes = Number(hospital.arrivalMinutes ?? 15);
  const addressText =
    hospital.address ||
    'Av. Jorge Jiménez Gallardo S/N, Col. San Sebastián Xhala, Cuautitlán Izcalli, Edo. de Méx., C.P. 54714 (Campo 4, a un costado del Hospital de Equinos)';
  const phoneText = hospital.phone || '55 5623 1999 (Ext. 39481 y 39484)';
  const emailText = hospital.email || 'hpe@cuautitlan.unam.mx';

  const petDisplay = petSpecies ? `${petName} (${petSpecies})` : petName;
  const timeDisplay = timeVal
    ? `${formatTime12h(timeVal)} (${timeVal} hrs · atención de 1 hora)`
    : '—';

  const detailRows = [
    createPdfRow('Servicio solicitado', serviceName),
    createPdfRow('Día de la cita', formatDateSpanish(dateVal) || dateVal),
    createPdfRow('Horario asignado', timeDisplay),
    createPdfRow('Mascota', petDisplay),
  ];

  if (petAge) {
    detailRows.push(createPdfRow('Edad aproximada', petAge));
  }

  detailRows.push(
    createPdfRow('Dueño o tutor', ownerName),
    createPdfRow('Teléfono registrado', ownerPhone)
  );

  if (reasonNotes) {
    detailRows.push(createPdfRow('Motivo de consulta', reasonNotes));
  }

  // Construcción completa de la hoja oficial en Azul UNAM, Oro UNAM y Blanco
  const documentCard = createEl('div', { className: 'pdf-page-frame' }, [
    // 1. Encabezado institucional Azul UNAM + franja Oro UNAM
    createEl('header', { className: 'pdf-header' }, [
      createEl('div', { className: 'pdf-logo-medallion' }, [
        createEl('img', {
          src: '/img/unamlogo.svg',
          alt: 'Escudo oficial de la UNAM',
          className: 'pdf-logo-img',
        }),
      ]),
      createEl('div', { className: 'pdf-header-copy' }, [
        createEl('p', {
          className: 'pdf-university',
          text: 'UNIVERSIDAD NACIONAL AUTÓNOMA DE MÉXICO',
        }),
        createEl('p', {
          className: 'pdf-campus',
          text: 'Facultad de Estudios Superiores Cuautitlán · Campo 4',
        }),
        createEl('h1', {
          className: 'pdf-hospital-name',
          text: 'Hospital de Pequeñas Especies',
        }),
      ]),
    ]),

    // 2. Franja de título del documento
    createEl('div', { className: 'pdf-doc-ribbon' }, [
      createEl('span', {
        className: 'pdf-doc-ribbon-title',
        text: 'COMPROBANTE OFICIAL DE CITA VETERINARIA',
      }),
      createEl('span', {
        className: 'pdf-doc-ribbon-date',
        text: `Emitido: ${formatIssuedTimestamp()}`,
      }),
    ]),

    // 3. Cuerpo principal
    createEl('div', { className: 'pdf-body' }, [
      // Caja destacada de Folio y Estado (Oro, Azul y Blanco)
      createEl('section', { className: 'pdf-folio-panel' }, [
        createEl('div', { className: 'pdf-folio-left' }, [
          createEl('div', { className: 'pdf-folio-label', text: 'NÚMERO DE FOLIO' }),
          createEl('div', { className: 'pdf-folio-code', text: folio }),
        ]),
        createEl('div', { className: 'pdf-folio-right' }, [
          createEl('div', { className: 'pdf-folio-label', text: 'ESTADO ACTUAL' }),
          createEl('span', { className: 'pdf-status-chip', text: statusLabel }),
        ]),
      ]),

      // Tabla oficial de detalles de la cita
      createEl('section', { className: 'pdf-section' }, [
        createEl('div', { className: 'pdf-section-bar', text: 'DATOS DE LA CITA PROGRAMADA' }),
        createEl('table', { className: 'pdf-details-table' }, [
          createEl('tbody', {}, detailRows),
        ]),
      ]),

      // Indicaciones importantes para el día de la visita
      createEl('section', { className: 'pdf-notes-box' }, [
        createEl('div', {
          className: 'pdf-notes-title',
          text: 'INDICACIONES IMPORTANTES PARA EL DÍA DE SU VISITA',
        }),
        createEl('ul', { className: 'pdf-notes-list' }, [
          createEl('li', {
            text: `Presentarse ${arrivalMinutes} minutos antes de su horario para registro en recepción.`,
          }),
          createEl('li', {
            text: 'Traer a su mascota con correa o transportadora segura y su cartilla de vacunación (si cuenta con ella).',
          }),
          createEl('li', {
            text: 'La atención es personalizada (1 cita por hora). Si no podrá asistir, cancele con anticipación usando su folio.',
          }),
          createEl('li', {
            text: 'Presente este comprobante impreso o en su teléfono celular al llegar al hospital.',
          }),
        ]),
      ]),
    ]),

    // 4. Pie institucional Azul UNAM con línea superior Oro UNAM
    createEl('footer', { className: 'pdf-footer' }, [
      createEl('div', {
        className: 'pdf-footer-contact',
        text: `Tel. ${phoneText}  ·  Correo: ${emailText}`,
      }),
      createEl('div', {
        className: 'pdf-footer-address',
        text: addressText,
      }),
    ]),
  ]);

  sheet.replaceChildren(documentCard);
  return String(folio);
}

/**
 * Construye la hoja oficial `#official-pdf-sheet` en colores Azul, Oro y Blanco UNAM
 * y abre el diálogo nativo del navegador para **Guardar como PDF** o **Imprimir**.
 *
 * @param {object} appointment - Datos de la cita (desde `wizard.js` o `lookup.js`).
 * @param {object} [hospitalInfo={}] - Datos institucionales desde `/api/public/config`.
 */
export function printOfficialReceipt(appointment, hospitalInfo = {}) {
  const folio = populateOfficialReceipt(appointment, hospitalInfo);

  // Nombre sugerido automático al elegir "Guardar como PDF"
  const originalTitle = document.title;
  const safeFolio = String(folio || 'CITA').replace(/[^A-Za-z0-9_-]/g, '');
  document.title = `Comprobante-Cita-${safeFolio}`;

  const restoreTitle = () => {
    document.title = originalTitle;
    window.removeEventListener('afterprint', restoreTitle);
  };
  window.addEventListener('afterprint', restoreTitle);

  window.print();
  // Respaldo por si el navegador no dispara afterprint en algunos entornos
  window.setTimeout(restoreTitle, 1500);
}
