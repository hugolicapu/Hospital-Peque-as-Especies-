/**
 * @file public/js/citas/receipt.js
 * @description Módulo reutilizable para generar y descargar comprobantes oficiales
 * de cita veterinaria en imagen PNG de alta resolución (100% en el navegador,
 * sin dependencias externas y cumpliendo CSP `'self'`).
 *
 * Lo comparten:
 * - `wizard.js` (pantalla de confirmación tras agendar)
 * - `lookup.js` (sección "Consultar o cancelar mi cita")
 */

import {
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
 * Carga una imagen del mismo origen (`/img/unamlogo.svg`) para dibujarla en Canvas.
 * Si falla, devuelve `null` para continuar generando el comprobante sin interrumpir.
 * @param {string} src
 * @returns {Promise<HTMLImageElement|null>}
 */
function loadLocalImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/**
 * Dibuja un rectángulo con esquinas redondeadas sobre un contexto 2D.
 */
function drawRoundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

/**
 * Divide un texto en líneas ajustadas a `maxWidth` y devuelve el arreglo de líneas.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} maxWidth
 * @returns {string[]}
 */
function wrapTextLines(ctx, text, maxWidth) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return ['—'];

  const lines = [];
  let current = words[0];

  for (let i = 1; i < words.length; i += 1) {
    const candidate = `${current} ${words[i]}`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = words[i];
    }
  }
  lines.push(current);
  return lines;
}

/**
 * Resuelve colores accesibles del estado para la insignia dibujada en el PNG.
 * @param {string} statusKey
 */
function getCanvasStatusColors(statusKey) {
  switch (statusKey) {
    case 'confirmada':
      return { bg: '#E7F6EE', border: '#1E7E4F', text: '#114D30' };
    case 'atendida':
      return { bg: '#E8F0FA', border: '#002B5C', text: '#002B5C' };
    case 'cancelada':
      return { bg: '#F1F3F5', border: '#6C757D', text: '#495057' };
    default:
      return { bg: '#FFF8E6', border: '#B37B00', text: '#5C3D00' };
  }
}

/**
 * Dispara la descarga local de un Blob sin abrir pestañas ni salir de la página.
 * @param {Blob} blob
 * @param {string} filename
 */
function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Respaldo en texto plano (`.txt`) por si el navegador no soporta exportación Canvas.
 */
function downloadReceiptFallbackText(data, hospital) {
  const lines = [
    '============================================================',
    '  HOSPITAL DE PEQUEÑAS ESPECIES · UNAM FES CUAUTITLÁN (CAMPO 4)',
    '  COMPROBANTE OFICIAL DE CITA VETERINARIA',
    '============================================================',
    `Folio:          ${data.folio}`,
    `Estado:         ${data.statusLabel}`,
    `Servicio:       ${data.serviceName}`,
    `Fecha:          ${data.readableDate}`,
    `Horario:        ${data.readableTime} (${data.time24} hrs)`,
    `Mascota:        ${data.petLabel}`,
    ...(data.petAge ? [`Edad:           ${data.petAge}`] : []),
    `Dueño / Tutor:  ${data.ownerName}`,
    `Teléfono:       ${data.ownerPhone}`,
    ...(data.reasonNotes ? [`Motivo:         ${data.reasonNotes}`] : []),
    '------------------------------------------------------------',
    `Indicaciones: Llegar ${data.arrivalMinutes} minutos antes con correa o transportadora.`,
    `Dirección: ${hospital.address || 'FES Cuautitlán Campo 4'}`,
    `Teléfono:  ${hospital.phone || '55 5623 1999 (Ext. 39481 y 39484)'}`,
    `Emitido:   ${formatIssuedTimestamp()}`,
    '============================================================',
  ];

  const blob = new Blob([lines.join('\r\n')], { type: 'text/plain;charset=utf-8' });
  const safeFolio = String(data.folio || 'CITA').replace(/[^A-Za-z0-9_-]/g, '');
  triggerBlobDownload(blob, `Comprobante-Cita-${safeFolio}.txt`);
}

/**
 * Genera y descarga un comprobante oficial en imagen PNG de alta calidad
 * (`Comprobante-Cita-FESC-YYYYMMDD-XXXX.png`) listo para guardar en galería o PC.
 *
 * @param {object} appointment - Datos de la cita (desde `wizard.js` o `lookup.js`).
 * @param {object} [hospitalInfo={}] - Datos institucionales desde `/api/public/config`.
 * @returns {Promise<'png'|'txt'>}
 */
export async function downloadReceiptPng(appointment, hospitalInfo = {}) {
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

  const normalized = {
    folio,
    serviceName,
    readableDate: formatDateSpanish(dateVal) || dateVal,
    readableTime: formatTime12h(timeVal) || timeVal,
    time24: timeVal,
    ownerName,
    ownerPhone,
    petLabel: petSpecies ? `${petName} (${petSpecies})` : petName,
    petAge,
    reasonNotes,
    statusKey,
    statusLabel,
    arrivalMinutes,
  };

  try {
    const width = 1200;
    const padX = 72;
    const contentWidth = width - padX * 2;
    const fontFamily = '"Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif';

    // Medimos filas dinámicamente antes de fijar la altura exacta del lienzo
    const measureCanvas = document.createElement('canvas');
    const mCtx = measureCanvas.getContext('2d');
    if (!mCtx) {
      downloadReceiptFallbackText(normalized, hospital);
      return 'txt';
    }

    const detailRows = [
      { label: 'Servicio solicitado', value: normalized.serviceName },
      { label: 'Día de la cita', value: normalized.readableDate },
      { label: 'Horario reservado', value: `${normalized.readableTime} (${normalized.time24} hrs · duración 1 hora)` },
      { label: 'Mascota', value: normalized.petLabel },
      ...(normalized.petAge ? [{ label: 'Edad aproximada', value: normalized.petAge }] : []),
      { label: 'Dueño o tutor', value: normalized.ownerName },
      { label: 'Teléfono registrado', value: normalized.ownerPhone },
      ...(normalized.reasonNotes ? [{ label: 'Motivo de consulta', value: normalized.reasonNotes }] : []),
    ];

    mCtx.font = `700 28px ${fontFamily}`;
    const valueMaxWidth = contentWidth - 340;
    const measuredRows = detailRows.map((row) => {
      const lines = wrapTextLines(mCtx, row.value, valueMaxWidth);
      const rowHeight = Math.max(66, lines.length * 36 + 30);
      return { ...row, lines, rowHeight };
    });

    const detailsCardHeight = measuredRows.reduce((acc, r) => acc + r.rowHeight, 0) + 20;
    const addressText =
      hospital.address ||
      'Av. Jorge Jiménez Gallardo S/N, Col. San Sebastián Xhala, Cuautitlán Izcalli, Edo. de Méx., C.P. 54714 (Campo 4)';
    const phoneText = hospital.phone || '55 5623 1999 (Ext. 39481 y 39484)';
    const emailText = hospital.email || 'hpe@cuautitlan.unam.mx';

    mCtx.font = `500 22px ${fontFamily}`;
    const addressLines = wrapTextLines(mCtx, `Dirección: ${addressText}`, contentWidth - 40);

    const headerHeight = 230;
    const folioBoxHeight = 215;
    const tipsHeight = 250;
    const footerHeight = 120 + addressLines.length * 30;
    const totalHeight = headerHeight + 44 + folioBoxHeight + 36 + detailsCardHeight + 36 + tipsHeight + 36 + footerHeight + 48;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = totalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      downloadReceiptFallbackText(normalized, hospital);
      return 'txt';
    }

    // Fondo general claro
    ctx.fillStyle = '#F4F7FB';
    ctx.fillRect(0, 0, width, totalHeight);

    // 1. ENCABEZADO INSTITUCIONAL UNAM (AZUL + BANDA ORO)
    ctx.fillStyle = '#002B5C';
    ctx.fillRect(0, 0, width, headerHeight);
    ctx.fillStyle = '#C59B27';
    ctx.fillRect(0, headerHeight - 10, width, 10);

    // Medallón blanco con escudo oficial de la UNAM
    const logoImg = await loadLocalImage('/img/unamlogo.svg');
    drawRoundedRect(ctx, padX, 42, 136, 136, 22);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#C59B27';
    ctx.stroke();

    if (logoImg) {
      ctx.drawImage(logoImg, padX + 16, 52, 104, 116);
    }

    // Textos del encabezado institucional
    const textStartX = padX + 166;
    ctx.fillStyle = '#F6DC8D';
    ctx.font = `800 24px ${fontFamily}`;
    ctx.fillText('UNAM · FES CUAUTITLÁN (CAMPO 4)', textStartX, 82);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = `800 42px ${fontFamily}`;
    ctx.fillText('Hospital de Pequeñas Especies', textStartX, 132);

    ctx.fillStyle = '#DCE7F5';
    ctx.font = `600 24px ${fontFamily}`;
    ctx.fillText('COMPROBANTE OFICIAL DE CITA VETERINARIA', textStartX, 174);

    // 2. CAJA DESTACADA DE FOLIO Y ESTADO
    let cursorY = headerHeight + 44;
    drawRoundedRect(ctx, padX, cursorY, contentWidth, folioBoxHeight, 22);
    ctx.fillStyle = '#FDF7E3';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#B38919';
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.fillStyle = '#002B5C';
    ctx.font = `800 23px ${fontFamily}`;
    ctx.fillText('NÚMERO DE FOLIO DE SU CITA', width / 2, cursorY + 48);

    ctx.fillStyle = '#001D3F';
    ctx.font = '900 58px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillText(normalized.folio, width / 2, cursorY + 118);

    // Insignia de estado
    const statusColors = getCanvasStatusColors(normalized.statusKey);
    ctx.font = `800 23px ${fontFamily}`;
    const pillWidth = Math.max(280, ctx.measureText(normalized.statusLabel).width + 64);
    const pillX = (width - pillWidth) / 2;
    const pillY = cursorY + 144;
    drawRoundedRect(ctx, pillX, pillY, pillWidth, 46, 23);
    ctx.fillStyle = statusColors.bg;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = statusColors.border;
    ctx.stroke();
    ctx.fillStyle = statusColors.text;
    ctx.fillText(normalized.statusLabel, width / 2, pillY + 31);
    ctx.textAlign = 'left';

    // 3. TARJETA DE DETALLES DE LA CITA
    cursorY += folioBoxHeight + 36;
    drawRoundedRect(ctx, padX, cursorY, contentWidth, detailsCardHeight, 20);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#8FA3BC';
    ctx.stroke();

    let rowY = cursorY + 10;
    measuredRows.forEach((row, index) => {
      if (index % 2 === 1) {
        ctx.fillStyle = '#F8FAFD';
        ctx.fillRect(padX + 3, rowY, contentWidth - 6, row.rowHeight);
      }

      if (index > 0) {
        ctx.strokeStyle = '#DCE4EE';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(padX + 24, rowY);
        ctx.lineTo(padX + contentWidth - 24, rowY);
        ctx.stroke();
      }

      ctx.fillStyle = '#425264';
      ctx.font = `700 24px ${fontFamily}`;
      ctx.fillText(row.label, padX + 30, rowY + 42);

      ctx.fillStyle = '#16202A';
      ctx.font = `800 27px ${fontFamily}`;
      row.lines.forEach((line, lineIdx) => {
        ctx.fillText(line, padX + 310, rowY + 42 + lineIdx * 36);
      });

      rowY += row.rowHeight;
    });

    // 4. INDICACIONES IMPORTANTES PARA LA VISITA
    cursorY += detailsCardHeight + 36;
    drawRoundedRect(ctx, padX, cursorY, contentWidth, tipsHeight, 20);
    ctx.fillStyle = '#E8F0FA';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#002B5C';
    ctx.stroke();

    ctx.fillStyle = '#002B5C';
    ctx.font = `800 27px ${fontFamily}`;
    ctx.fillText('INDICACIONES PARA EL DÍA DE SU CITA', padX + 32, cursorY + 48);

    const bullets = [
      `• Llegue ${normalized.arrivalMinutes} minutos antes de su horario para registro en recepción.`,
      '• Traiga a su mascota con correa o transportadora segura y su cartilla si cuenta con ella.',
      '• La atención es personalizada (1 cita por hora). Si no puede asistir, cancele con su folio.',
      '• Presente este comprobante en su celular o impreso al llegar al hospital.',
    ];
    ctx.fillStyle = '#16202A';
    ctx.font = `600 23px ${fontFamily}`;
    bullets.forEach((line, idx) => {
      ctx.fillText(line, padX + 32, cursorY + 96 + idx * 38);
    });

    // 5. PIE INSTITUCIONAL DE CONTACTO Y EMISIÓN
    cursorY += tipsHeight + 36;
    drawRoundedRect(ctx, padX, cursorY, contentWidth, footerHeight, 18);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#C5D1E0';
    ctx.stroke();

    ctx.fillStyle = '#002B5C';
    ctx.font = `800 23px ${fontFamily}`;
    ctx.fillText(`Teléfono de apoyo: ${phoneText}   ·   Correo: ${emailText}`, padX + 26, cursorY + 42);

    ctx.fillStyle = '#425264';
    ctx.font = `500 21px ${fontFamily}`;
    addressLines.forEach((line, idx) => {
      ctx.fillText(line, padX + 26, cursorY + 78 + idx * 30);
    });

    ctx.fillStyle = '#5A6B7D';
    ctx.font = `600 19px ${fontFamily}`;
    ctx.fillText(
      `Comprobante emitido el ${formatIssuedTimestamp()}`,
      padX + 26,
      cursorY + footerHeight - 18
    );

    const safeFolio = String(normalized.folio).replace(/[^A-Za-z0-9_-]/g, '');
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png', 1.0));
    if (!blob) {
      downloadReceiptFallbackText(normalized, hospital);
      return 'txt';
    }

    triggerBlobDownload(blob, `Comprobante-Cita-${safeFolio}.png`);
    return 'png';
  } catch {
    downloadReceiptFallbackText(normalized, hospital);
    return 'txt';
  }
}
