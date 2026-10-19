import { ApiError } from './http.js';

const USER_PROFILES_MIGRATION = '0003_user_profiles.sql';
const USER_PROFILES_MIGRATION_COMMAND = 'npx wrangler d1 migrations apply <database-name> --remote';

/**
 * Verify the profile table before any query that names user_profiles.
 *
 * This intentionally does not cache the result: a process may stay alive while
 * a local/remote migration is applied, and the next request should recover.
 */
export async function ensureUserProfilesSchema(db) {
  try {
    await db.prepare(
      'SELECT user_id, nickname, dashboard_position, quote, photo, photo_mime, version FROM user_profiles LIMIT 0'
    ).all();
    return true;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      503,
      'migration_required',
      `Database belum siap: migrasi ${USER_PROFILES_MIGRATION} harus diterapkan sebelum masuk atau mengakses profil. Jalankan ${USER_PROFILES_MIGRATION_COMMAND} lalu ulangi permintaan.`
    );
  }
}

export const USER_PROFILES_MIGRATION_FILE = USER_PROFILES_MIGRATION;
