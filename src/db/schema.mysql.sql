-- =============================================================================
-- Esquema de Base de Datos MySQL / MariaDB (XAMPP)
-- Hospital de Pequeñas Especies · UNAM FES Cuautitlán (Campo 4)
-- =============================================================================
-- Compatible con MariaDB 10.4+ (incluido en XAMPP 8.2) y MySQL 8+.
-- Codificación utf8mb4 para acentos y caracteres en español.

-- 1. Cuenta única de administrador (Single-Admin).
-- La restricción CHECK (id = 1) impide a nivel de motor que exista más de un admin.
CREATE TABLE IF NOT EXISTS admin_account (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  username VARCHAR(60) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  active_session_id VARCHAR(255) NULL,
  failed_attempts INT UNSIGNED NOT NULL DEFAULT 0,
  locked_until VARCHAR(40) NULL,
  updated_at VARCHAR(40) NOT NULL,
  CONSTRAINT chk_single_admin_id CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Catálogo de servicios veterinarios disponibles para agendar cita.
CREATE TABLE IF NOT EXISTS services (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL UNIQUE,
  description VARCHAR(500) NOT NULL,
  icon VARCHAR(80) NOT NULL DEFAULT 'bi-heart-pulse-fill',
  duration_minutes INT UNSIGNED NOT NULL DEFAULT 60,
  active TINYINT(1) NOT NULL DEFAULT 1,
  CONSTRAINT chk_services_active CHECK (active IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Reglas semanales de horario de atención (0 = Domingo ... 6 = Sábado).
CREATE TABLE IF NOT EXISTS schedule_rules (
  day_of_week TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  is_open TINYINT(1) NOT NULL DEFAULT 0,
  start_time CHAR(5) NOT NULL,
  end_time CHAR(5) NOT NULL,
  slot_minutes INT UNSIGNED NOT NULL DEFAULT 60,
  capacity_per_slot INT UNSIGNED NOT NULL DEFAULT 1,
  CONSTRAINT chk_schedule_day CHECK (day_of_week BETWEEN 0 AND 6),
  CONSTRAINT chk_schedule_open CHECK (is_open IN (0, 1)),
  CONSTRAINT chk_schedule_slot CHECK (slot_minutes IN (15, 20, 30, 45, 60)),
  CONSTRAINT chk_schedule_capacity CHECK (capacity_per_slot BETWEEN 1 AND 20)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Fechas o franjas horarias bloqueadas (días festivos, mantenimiento, eventos).
-- Si blocked_time es '', se bloquea todo el día; si tiene 'HH:MM', solo esa franja.
CREATE TABLE IF NOT EXISTS blocked_dates (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  blocked_date CHAR(10) NOT NULL,
  blocked_time VARCHAR(5) NOT NULL DEFAULT '',
  reason VARCHAR(255) NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  UNIQUE KEY uq_blocked_date_time (blocked_date, blocked_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Registro de citas agendadas por los tutores.
CREATE TABLE IF NOT EXISTS appointments (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  folio VARCHAR(30) NOT NULL UNIQUE,
  service_id INT UNSIGNED NOT NULL,
  appointment_date CHAR(10) NOT NULL,
  appointment_time CHAR(5) NOT NULL,
  owner_name VARCHAR(150) NOT NULL,
  owner_phone VARCHAR(25) NOT NULL,
  owner_email VARCHAR(160) NOT NULL DEFAULT '',
  pet_name VARCHAR(100) NOT NULL,
  pet_species VARCHAR(60) NOT NULL,
  pet_age VARCHAR(60) NOT NULL DEFAULT '',
  reason_notes VARCHAR(600) NOT NULL DEFAULT '',
  status ENUM('pendiente', 'confirmada', 'atendida', 'cancelada') NOT NULL DEFAULT 'pendiente',
  admin_notes VARCHAR(1000) NOT NULL DEFAULT '',
  created_at VARCHAR(40) NOT NULL,
  updated_at VARCHAR(40) NOT NULL,
  INDEX idx_appointments_date_time (appointment_date, appointment_time, status),
  INDEX idx_appointments_folio (folio),
  CONSTRAINT fk_appointments_service
    FOREIGN KEY (service_id) REFERENCES services(id)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Bitácora de auditoría de seguridad y cambios administrativos.
CREATE TABLE IF NOT EXISTS audit_logs (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_type VARCHAR(80) NOT NULL,
  actor VARCHAR(80) NOT NULL,
  ip_address VARCHAR(64) NOT NULL DEFAULT '',
  details VARCHAR(1000) NOT NULL DEFAULT '',
  created_at VARCHAR(40) NOT NULL,
  INDEX idx_audit_logs_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
