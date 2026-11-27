---
name: hospital-citas-fesc
description: Convenciones, contratos de API, arquitectura modular, seguridad single-admin y reglas de accesibilidad para el Sistema de Citas del Hospital de Pequeñas Especies UNAM FESC Campo 4. Úsalo para mantener consistencia y ahorrar tokens al editar backend o frontend.
---

# Hospital de Pequeñas Especies UNAM FESC Campo 4 — Guía de Arquitectura y Contrato

## Stack Técnico
- **Runtime:** Node.js v22+ (CommonJS en `src/`, ES Modules en `public/js/`).
- **Base de datos:** SQLite nativo (`node:sqlite` `DatabaseSync`), esquema en `src/db/schema.sql`.
- **Backend:** Express 4, Helmet, express-session, express-rate-limit, bcryptjs, zod, dotenv.
- **Frontend:** Bootstrap 5.3 + Bootstrap Icons servidos localmente en `/vendor/bootstrap/` y `/vendor/bootstrap-icons/`.
- **En Windows PowerShell:** Usar `npm.cmd` si `npm.ps1` está bloqueado por ExecutionPolicy.

## Reglas de Código y Comentarios
1. Todo archivo lleva cabecera JSDoc en español explicando su propósito y relación con el resto del proyecto.
2. Comentarios internos breves explicando el **por qué** de cada regla de negocio o medida de seguridad.
3. Código modular y funciones pequeñas; nunca renderizar texto del usuario con `innerHTML` sin escapar (preferir `textContent` y nodos DOM).
4. Mensajes visibles para humanos en **español claro**, sin jerga técnica.

## Seguridad Obligatoria (Panel de Administrador Único)
1. **Single-Admin:** Solo existe 1 fila (`id = 1`) en `admin_account`. Sin endpoint de registro público.
2. **Sesión exclusiva:** `admin_account.active_session_id` debe coincidir con `req.sessionID`. Iniciar sesión reemplaza la sesión previa.
3. **Timeout por inactividad:** Verificar `req.session.lastActivity` en cada petición protegida (default 15 min).
4. **CSRF:** Todo `POST`, `PUT`, `PATCH`, `DELETE` bajo `/api/admin/*` requiere header `X-CSRF-Token` igual a `req.session.csrfToken`.
5. **Anti-fuerza bruta:** Rate limit en `/api/admin/login` + bloqueo temporal de cuenta tras 5 fallos por 15 minutos.
6. **Helmet CSP:** Solo `'self'` para scripts y estilos (sin scripts inline en HTML ni CDN externos).

## Accesibilidad Obligatoria (Página Pública de Citas)
- Público objetivo: incluye **personas mayores**.
- Tipografía base >= 18px, botones mínimos de 52px de alto, alto contraste UNAM (`#002B5C` azul, `#C59B27` oro, texto `#1A202C` sobre `#FFFFFF`/`#F4F6F9`).
- Flujo en 4 pasos claros con barra de progreso visible, ayudas con ejemplos y controles `A-`/`A+` + Alto Contraste persistentes en `localStorage`.

## Contrato de API JSON
- Éxito: `{ "ok": true, "message"?: string, "data": any }`
- Error: `{ "ok": false, "error": string, "details"?: Array<{ field, message }> }`

### Rutas Públicas (`/api/public`)
- `GET /api/public/config` → `{ hospital, species, services, schedule, maxDaysAhead }`
- `GET /api/public/availability?date=YYYY-MM-DD` → `{ date, isOpen, dayBlocked, blockReason, slots: [{ time, available, capacity, isAvailable, reason }] }`
- `POST /api/public/appointments` → Body `{ serviceId, date, time, ownerName, ownerPhone, ownerEmail?, petName, petSpecies, petAge?, reasonNotes? }` → `201` `{ folio, serviceName, date, time, ownerName, ownerPhone, petName, petSpecies, status }`
- `GET /api/public/appointments/lookup?folio=...&phone=...` → cita del tutor (sin `adminNotes`).
- `POST /api/public/appointments/cancel` → Body `{ folio, phone }` → cancela y libera horario.

### Rutas de Administrador (`/api/admin`)
- `GET /api/admin/csrf-token` → `{ csrfToken }`
- `GET /api/admin/session` → `{ authenticated, adminConfigured, username?, timeoutMinutes, csrfToken }`
- `POST /api/admin/login` (CSRF) → Body `{ username, password }` → `{ username, csrfToken, timeoutMinutes }`
- `POST /api/admin/logout` (Auth + CSRF)
- `POST /api/admin/change-password` (Auth + CSRF) → Body `{ currentPassword, newPassword }`
- `GET /api/admin/dashboard?date=YYYY-MM-DD` (Auth) → `{ date, stats: { total, pendiente, confirmada, atendida, cancelada }, appointments }`
- `GET /api/admin/appointments?date=&status=&search=` (Auth) → lista de citas con `serviceName`, `adminNotes`, etc.
- `PATCH /api/admin/appointments/:id` (Auth + CSRF) → Body `{ status?, date?, time?, adminNotes? }`
- `GET /api/admin/schedule` (Auth) → `{ rules, blockedDates, services }`
- `PUT /api/admin/schedule/rules` (Auth + CSRF) → Body `{ rules: [{ dayOfWeek, isOpen, startTime, endTime, slotMinutes, capacityPerSlot }] }`
- `POST /api/admin/schedule/blocks` (Auth + CSRF) → Body `{ blockedDate, blockedTime?, reason }`
- `DELETE /api/admin/schedule/blocks/:id` (Auth + CSRF)
- `PATCH /api/admin/services/:id` (Auth + CSRF) → Body `{ active?, description?, durationMinutes? }`
- `GET /api/admin/audit-logs?limit=50` (Auth) → lista de eventos de auditoría.

### Rutas de Páginas y Estáticos
- `GET /` → `public/index.html` (Sistema Público de Citas)
- `GET /admin` → `public/admin.html` (Panel de Administrador Único)
- `GET /vendor/bootstrap/*` → `node_modules/bootstrap/dist/*`
- `GET /vendor/bootstrap-icons/*` → `node_modules/bootstrap-icons/font/*`
