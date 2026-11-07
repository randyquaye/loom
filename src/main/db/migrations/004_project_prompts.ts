import type Database from 'better-sqlite3'
import type { Migration } from './index'

export const m004: Migration = {
  name: '004_project_prompts',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE projects ADD COLUMN custom_prompt_general TEXT;
      ALTER TABLE projects ADD COLUMN custom_prompt_code_review TEXT;
      ALTER TABLE projects ADD COLUMN custom_prompt_fix_errors TEXT;
    `)
  }
}
