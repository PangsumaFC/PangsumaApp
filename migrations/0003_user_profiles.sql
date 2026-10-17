PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  nickname TEXT NOT NULL DEFAULT '' CHECK (length(nickname) <= 40),
  dashboard_position TEXT CHECK (dashboard_position IS NULL OR length(dashboard_position) <= 80),
  quote TEXT NOT NULL DEFAULT '' CHECK (length(quote) <= 300),
  photo BLOB CHECK (photo IS NULL OR length(photo) <= 131072),
  photo_mime TEXT CHECK (photo_mime IS NULL OR photo_mime IN ('image/jpeg', 'image/png', 'image/webp')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
);
CREATE INDEX IF NOT EXISTS idx_user_profiles_version ON user_profiles(version);
