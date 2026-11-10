import { open } from 'node:fs/promises'
import type { FilePreview } from '../../shared/ipc-contract'
import { MAX_IMAGE_ATTACHMENT_BYTES } from '../../shared/limits'
import { contain } from '../security/contain'
import { FileTooLargeError, NotAFileError, readFileJailed } from './read'

/** Image signatures choose the preview; text keeps its existing reader and limits. */
export async function readFilePreview(root: string, relPath: string): Promise<FilePreview> {
  const file = await open(await contain(root, relPath), 'r')
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new NotAFileError(`not a regular file: ${relPath}`)
    const head = Buffer.alloc(12)
    await file.read(head, 0, head.length, 0)
    let mimeType: string | undefined
    if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mimeType = 'image/png'
    else if (head[0] === 255 && head[1] === 216 && head[2] === 255) mimeType = 'image/jpeg'
    else if (['GIF87a', 'GIF89a'].includes(head.subarray(0, 6).toString('ascii'))) mimeType = 'image/gif'
    else if (
      head.subarray(0, 4).toString('ascii') === 'RIFF' &&
      head.subarray(8, 12).toString('ascii') === 'WEBP'
    )
      mimeType = 'image/webp'
    if (mimeType === undefined) return { kind: 'text', ...(await readFileJailed(root, relPath)) }
    const limit = MAX_IMAGE_ATTACHMENT_BYTES
    if (info.size > limit) throw new FileTooLargeError(`image exceeds ${limit} bytes: ${relPath}`)
    // Bound the stream too, in case the file grows after stat().
    const chunks: Buffer[] = []
    for await (const chunk of file.createReadStream({ start: 0, end: limit, autoClose: false })) {
      chunks.push(chunk)
    }
    const bytes = Buffer.concat(chunks)
    if (bytes.length > limit) throw new FileTooLargeError(`image exceeds ${limit} bytes: ${relPath}`)
    return { kind: 'image', mimeType, dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}` }
  } finally {
    await file.close()
  }
}
