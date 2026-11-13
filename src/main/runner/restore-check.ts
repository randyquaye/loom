import { verifyRestoredData } from './restore'

async function main(): Promise<void> {
  const directory = process.argv[2]
  if (directory === undefined || process.argv[3] !== '--isolated-copy')
    throw new Error('Usage: restore-check.js DATA_DIR --isolated-copy; never run against the live data disk')
  const key = Buffer.from(process.env['LOOM_SECRET_KEY'] ?? '', 'base64')
  const report = await verifyRestoredData(directory, key)
  console.log(JSON.stringify({ restoreVerified: true, ...report }))
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Restore verification failed')
  process.exitCode = 1
})
