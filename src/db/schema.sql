-- =============================================================================
-- Esquema de Base de Datos SQLite
-- Hospital de Pequeñas Especies · UNAM FES Cuautitlán (Campo 4)
-- =============================================================================
-- NOTA: Se habilitan llaves foráneas (PRAGMA foreign_keys = ON) desde database.js.

-- 1. Cuenta única de administrador (Single-Admin).
-- La restricción CHECK (id = 1) garantiza a nivel de base de datos que NUNCA
-- pueda existir más de un administrador registrado en el sistema.
CREATE TABLE IF NOT EXISTS admin_account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  active_session_id TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at TEXT NOT NULL
);

-- 2. Catálogo de servicios veterinarios disponibles para agendar cita.
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'bi-heart-pulse-fill',
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

-- 3. Reglas semanales de horario de atención (0 = Domingo ... 6 = Sábado).
-- Permite al administrador cambiar horarios, duración de bloque y cupos sin tocar código.
CREATE TABLE IF NOT EXISTS schedule_rules (
  day_of_week INTEGER PRIMARY KEY CHECK (day_of_week BETWEEN 0 AND 6),
  is_open INTEGER NOT NULL DEFAULT 0 CHECK (is_open IN (0, 1)),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  slot_minutes INTEGER NOT NULL DEFAULT 30 CHECK (slot_minutes IN (15, 20, 30, 45, 60)),
  capacity_per_slot INTEGER NOT NULL DEFAULT 2 CHECK (capacity_per_slot BETWEEN 1 AND 20)
);

-- 4. Fechas o franjas horarias bloqueadas (días festivos, mantenimiento, eventos).
-- Si blocked_time es NULL o '', se bloquea todo el día.
-- Si blocked_time tiene formato 'HH:MM', se bloquea únicamente ese horario.
CREATE TABLE IF NOT EXISTS blocked_dates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  blocked_date TEXT NOT NULL,
  blocked_time TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (blocked_date, blocked_time)
);

-- 5. Registro de citas agendadas por los tutores.
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folio TEXT NOT NULL UNIQUE,
  service_id INTEGER NOT NULL,
  appointment_date TEXT NOT NULL,
  appointment_time TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  owner_phone TEXT NOT NULL,
  owner_email TEXT DEFAULT '',
  pet_name TEXT NOT NULL,
  pet_species TEXT NOT NULL,
  pet_age TEXT DEFAULT '',
  reason_notes TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (status IN ('pendiente', 'confirmada', 'atendida', 'cancelada')),
  admin_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (service_id) REFERENCES services(id)
);

-- Índices para acelerar búsquedas por fecha/hora (disponibilidad) y folio.
CREATE INDEX IF NOT EXISTS idx_appointments_date_time
  ON appointments (appointment_date, appointment_time, status);

CREATE INDEX IF NOT EXISTS idx_appointments_folio
  ON appointments (folio);

-- 6. Bitácora de auditoría de seguridad y cambios administrativos.
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  ip_address TEXT DEFAULT '',
  details TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
  ON audit_logs (created_at DESC);
