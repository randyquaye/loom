import { desktopUpdateSettings } from './scripts/desktop-update-config.mjs'

const updates = desktopUpdateSettings(process.env.LOOM_DESKTOP_UPDATE_URL, process.env.APPLE_TEAM_ID)
export default {
  extends: './electron-builder.release.yml',
  // Save Apple's submission ID before waiting; the hook staples before ZIP creation.
  afterSign: './scripts/notarize.mjs',
  mac: { notarize: false },
  publish: { provider: 'generic', url: updates.url },
  extraMetadata: { loomDesktopUpdates: updates },
  // The updater consumes the ZIP. DMG stapling occurs after installer creation.
  dmg: { writeUpdateInfo: false }
}
