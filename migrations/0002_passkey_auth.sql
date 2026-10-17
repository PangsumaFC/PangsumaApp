PRAGMA foreign_keys = ON;

ALTER TABLE sessions
  ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'password'
  CHECK (auth_method IN ('password', 'passkey'));

ALTER TABLE users ADD COLUMN webauthn_user_handle TEXT;
UPDATE users
SET webauthn_user_handle = lower(hex(randomblob(16)))
WHERE webauthn_user_handle IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_webauthn_user_handle
  ON users(webauthn_user_handle)
  WHERE webauthn_user_handle IS NOT NULL;

CREATE TABLE IF NOT EXISTS passkey_invitations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  consumed_at_ms INTEGER,
  revoked_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_passkey_invitations_user
  ON passkey_invitations(user_id, created_at_ms DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_passkey_invitations_one_open
  ON passkey_invitations(user_id)
  WHERE consumed_at_ms IS NULL AND revoked_at_ms IS NULL;

CREATE TABLE IF NOT EXISTS passkey_manager_recovery (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  secret_hash TEXT NOT NULL CHECK (length(secret_hash) = 64),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  consumed_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS passkey_challenges (
  challenge_id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (purpose IN (
    'discoverable-login', 'manager-invitation', 'manager-registration', 'manager-recovery'
  )),
  user_id TEXT REFERENCES users(id),
  context_id TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  consumed_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_passkey_challenges_expiry
  ON passkey_challenges(expires_at_ms, consumed_at_ms);
CREATE INDEX IF NOT EXISTS idx_passkey_challenges_user
  ON passkey_challenges(user_id, purpose, expires_at_ms);

CREATE TABLE IF NOT EXISTS passkey_credentials (
  credential_id TEXT PRIMARY KEY CHECK (length(credential_id) BETWEEN 1 AND 1400),
  user_id TEXT NOT NULL REFERENCES users(id),
  public_key_jwk TEXT NOT NULL CHECK (length(public_key_jwk) BETWEEN 1 AND 2048),
  algorithm INTEGER NOT NULL CHECK (algorithm = -7),
  sign_count INTEGER NOT NULL DEFAULT 0 CHECK (sign_count BETWEEN 0 AND 4294967295),
  backup_eligible INTEGER NOT NULL CHECK (backup_eligible IN (0, 1)),
  backup_state INTEGER NOT NULL CHECK (backup_state IN (0, 1)),
  registration_method TEXT NOT NULL CHECK (registration_method IN (
    'manager-recovery', 'manager-self', 'manager-invitation'
  )),
  registration_actor_id TEXT NOT NULL REFERENCES users(id),
  invitation_id TEXT REFERENCES passkey_invitations(id),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  CHECK (backup_state = 0 OR backup_eligible = 1),
  CHECK (
    (registration_method = 'manager-invitation' AND invitation_id IS NOT NULL) OR
    (registration_method <> 'manager-invitation' AND invitation_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_passkey_credentials_user
  ON passkey_credentials(user_id, created_at);

CREATE TABLE IF NOT EXISTS passkey_request_limits (
  rate_key TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL CHECK (request_count BETWEEN 0 AND 1000000),
  window_started_ms INTEGER NOT NULL CHECK (window_started_ms >= 0),
  blocked_until_ms INTEGER NOT NULL DEFAULT 0 CHECK (blocked_until_ms >= 0)
);
CREATE INDEX IF NOT EXISTS idx_passkey_request_limits_window
  ON passkey_request_limits(window_started_ms, blocked_until_ms);

CREATE TRIGGER IF NOT EXISTS passkey_credentials_registration_guard
BEFORE INSERT ON passkey_credentials
BEGIN
  SELECT CASE
    WHEN NEW.registration_method = 'manager-invitation' AND NOT EXISTS (
      SELECT 1
      FROM users target
      JOIN passkey_invitations invitation ON invitation.id = NEW.invitation_id
      WHERE target.id = NEW.user_id
        AND target.role = 'user'
        AND target.is_active = 1
        AND invitation.user_id = NEW.user_id
        AND invitation.created_by = NEW.registration_actor_id
        AND invitation.consumed_at_ms IS NULL
        AND invitation.revoked_at_ms IS NULL
    ) THEN RAISE(ABORT, 'invalid_passkey_invitation')
    WHEN NEW.registration_method = 'manager-self' AND NOT EXISTS (
      SELECT 1 FROM users target
      WHERE target.id = NEW.user_id
        AND target.id = NEW.registration_actor_id
        AND target.role = 'manager'
        AND target.is_active = 1
    ) THEN RAISE(ABORT, 'manager_passkey_required')
    WHEN NEW.registration_method = 'manager-recovery' AND NOT EXISTS (
      SELECT 1 FROM users target
      JOIN passkey_manager_recovery recovery ON recovery.user_id = target.id
      WHERE target.id = NEW.user_id
        AND target.id = NEW.registration_actor_id
        AND target.email = 'rahmat@pangsumafc.com' COLLATE NOCASE
        AND target.role = 'manager'
        AND target.is_active = 1
        AND recovery.consumed_at_ms IS NULL
    ) THEN RAISE(ABORT, 'invalid_manager_recovery')
  END;
END;

CREATE TRIGGER IF NOT EXISTS passkey_invitation_consumed
AFTER INSERT ON passkey_credentials
WHEN NEW.registration_method = 'manager-invitation'
BEGIN
  UPDATE passkey_invitations
  SET consumed_at_ms = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  WHERE id = NEW.invitation_id
    AND consumed_at_ms IS NULL
    AND revoked_at_ms IS NULL;
  UPDATE users
  SET must_change_password = 0,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      updated_by = NEW.registration_actor_id
  WHERE id = NEW.user_id AND role = 'user';
END;

CREATE TRIGGER IF NOT EXISTS passkey_manager_recovery_consumed
AFTER INSERT ON passkey_credentials
WHEN NEW.registration_method = 'manager-recovery'
BEGIN
  UPDATE passkey_manager_recovery
  SET consumed_at_ms = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  WHERE user_id = NEW.user_id AND consumed_at_ms IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS passkey_credential_audit
AFTER INSERT ON passkey_credentials
BEGIN
  INSERT INTO audit_events (actor_id, action, entity_type, entity_id, details_json, created_at)
  VALUES (
    NEW.registration_actor_id,
    'passkey.registered',
    'passkey',
    NEW.credential_id,
    json_object(
      'user_id', NEW.user_id,
      'method', NEW.registration_method,
      'backup_eligible', NEW.backup_eligible,
      'backup_state', NEW.backup_state
    ),
    NEW.created_at
  );
END;
