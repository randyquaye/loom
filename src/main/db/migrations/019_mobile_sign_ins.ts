import type { Migration } from './index'

/** Client authority belongs to the durable sign-in, not its short-lived browser code. */
export const m019: Migration = {
  name: '019_mobile_sign_ins',
  up(db) {
    db.exec(`ALTER TABLE sign_ins ADD COLUMN client_kind TEXT NOT NULL DEFAULT 'desktop'
      CHECK (client_kind IN ('desktop','mobile'))`)
  }
}
