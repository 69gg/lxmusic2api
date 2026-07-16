import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

const MIGRATIONS: readonly string[] = [
  `
    CREATE TABLE download_jobs (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled', 'expired')),
      track_json TEXT NOT NULL,
      resolved_track_json TEXT,
      requested_quality TEXT NOT NULL,
      resolved_quality TEXT,
      strict_quality INTEGER NOT NULL,
      source_fallback_used INTEGER NOT NULL DEFAULT 0,
      quality_fallback_used INTEGER NOT NULL DEFAULT 0,
      file_path TEXT,
      file_name TEXT,
      content_type TEXT,
      bytes_downloaded INTEGER NOT NULL DEFAULT 0,
      total_bytes INTEGER,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      expires_at TEXT
    );
    CREATE INDEX download_jobs_state_created_idx ON download_jobs (state, created_at);
    CREATE INDEX download_jobs_expires_idx ON download_jobs (expires_at);
  `,
]

export class AppDatabase {
  public readonly connection: Database.Database

  public constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true })
    this.connection = new Database(databasePath)
    this.connection.pragma('journal_mode = WAL')
    this.connection.pragma('foreign_keys = ON')
    this.connection.pragma('busy_timeout = 5000')
    this.#migrate()
  }

  #migrate(): void {
    const currentVersion = this.connection.pragma('user_version', { simple: true }) as number
    if (currentVersion > MIGRATIONS.length) {
      throw new Error(`数据库版本 ${currentVersion} 高于当前程序支持的版本 ${MIGRATIONS.length}`)
    }
    const migrate = this.connection.transaction(() => {
      for (let index = currentVersion; index < MIGRATIONS.length; index += 1) {
        const migration = MIGRATIONS[index]
        if (!migration) throw new Error(`缺少数据库迁移 ${index + 1}`)
        this.connection.exec(migration)
        this.connection.pragma(`user_version = ${index + 1}`)
      }
    })
    migrate()
  }

  public close(): void {
    if (this.connection.open) this.connection.close()
  }
}
