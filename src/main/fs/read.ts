import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { contain } from '../security/contain'

export const MAX_READ_BYTES = 2_000_000
const BINARY_SNIFF_BYTES = 8192

export class BinaryFileError extends Error {
  override readonly name = 'BinaryFileError'
}

export class FileTooLargeError extends Error {
  override readonly name = 'FileTooLargeError'
}

export class NotAFileError extends Error {
  override readonly name = 'NotAFileError'
}

const LANGUAGE_BY_EXT: Readonly<Record<string, string>> = {
  '.md': 'markdown',
  '.json': 'json',
  '.js': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.sh': 'shell',
  '.py': 'python',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.tf': 'hcl'
}

export function languageFor(relPath: string): string {
  return LANGUAGE_BY_EXT[path.extname(relPath).toLowerCase()] ?? 'plaintext'
}

export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)
}

export async function readFileJailed(
  worktreePath: string,
  relPath: string
): Promise<{ text: string; language: string }> {
  const abs = await contain(worktreePath, relPath)
  const info = await stat(abs)
  if (!info.isFile()) throw new NotAFileError(`not a regular file: ${relPath}`)
  if (info.size > MAX_READ_BYTES) {
    throw new FileTooLargeError(`file exceeds ${MAX_READ_BYTES} bytes: ${relPath}`)
  }
  const buf = await readFile(abs)
  if (looksBinary(buf)) throw new BinaryFileError(`binary file: ${relPath}`)
  return { text: buf.toString('utf8'), language: languageFor(relPath) }
}
