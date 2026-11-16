export function desktopUpdateSettings(value, teamId) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('Set LOOM_DESKTOP_UPDATE_URL to the HTTPS website update directory')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('Desktop update URL must use HTTPS without credentials, query, or fragment')
  if (!/^[A-Z0-9]{10}$/.test(teamId ?? '')) throw new Error('Set a valid APPLE_TEAM_ID')
  return { url: url.href.replace(/\/?$/, '/'), teamId }
}
