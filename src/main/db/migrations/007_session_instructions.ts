import type { Migration } from './index'

export const m007: Migration = {
  name: '007_session_instructions',
  up(db) {
    db.exec('ALTER TABLE sessions ADD COLUMN instruction_snapshot TEXT;')
  }
}
