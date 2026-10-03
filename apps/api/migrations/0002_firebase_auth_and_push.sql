-- 0002_firebase_auth_and_push.sql
-- Firebase Authentication is now the source of truth for identity. Users keep
-- their existing rows and gain a link to the Firebase UID; the phone column is
-- still populated from the verified ID token, so nothing that reads users.phone
-- breaks.

ALTER TABLE users ADD COLUMN firebase_uid TEXT;

-- Partial index: a UNIQUE constraint on a nullable column would allow many NULLs
-- on SQLite anyway, but being explicit documents that legacy OTP users may not
-- have a Firebase UID yet.
CREATE UNIQUE INDEX idx_users_firebase_uid ON users (firebase_uid)
  WHERE firebase_uid IS NOT NULL;

-- One row per installed app instance that can receive push. A token is globally
-- unique: re-registering the same device on a new account must move ownership,
-- not create a duplicate, so the token (not user_id+token) is the unique key.
CREATE TABLE device_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  platform   TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_device_tokens_user ON device_tokens (user_id);
