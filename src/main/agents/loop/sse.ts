/** Yields the payload of each SSE `data:` line from a chunked byte stream. */
export async function* ssePayloads(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = ''
  for await (const chunk of chunks) {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.startsWith('data:')) yield line.slice(5).trim()
      newline = buffer.indexOf('\n')
    }
  }
  if (buffer.startsWith('data:')) yield buffer.slice(5).trim()
}

/** Decodes a fetch response body into string chunks. */
export async function* bodyChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    if (value) yield decoder.decode(value, { stream: true })
  }
}
