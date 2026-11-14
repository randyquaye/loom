import { publishTransportProof } from './transport-proof'

async function main(): Promise<void> {
  const [host, keyFile, outputFile, extra] = process.argv.slice(2)
  if (!host || !keyFile || !outputFile || extra !== undefined)
    throw new Error('Usage: transport-proof.js HOST KEY_FILE OUTPUT_FILE')
  await publishTransportProof({ host, keyFile, outputFile })
}

main().catch((error: unknown) => {
  console.error(`[loom-transport-proof] ${error instanceof Error ? error.message : 'Publication failed'}`)
  process.exitCode = 1
})
