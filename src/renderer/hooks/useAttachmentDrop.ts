import { useRef, useState, type DragEvent } from 'react'
import { MAX_ATTACHMENTS, MAX_IMAGE_ATTACHMENT_BYTES, MAX_TEXT_ATTACHMENT_BYTES } from '../../shared/limits'
import { useUi } from '../state/ui'
import { useToasts } from '../components/ui/Toast'

/** Both composer modes use the same draft attachment state and native file-path bridge. */
export function useAttachmentDrop(key: string, disabled: boolean) {
  const depth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const push = useToasts((state) => state.push)
  const files = (event: DragEvent) => event.dataTransfer.types.includes('Files')
  const clear = () => {
    depth.current = 0
    setDragging(false)
  }
  return {
    dragging,
    handlers: {
      onDragEnter(event: DragEvent<HTMLDivElement>) {
        if (!files(event)) return
        event.preventDefault()
        if (!disabled) {
          depth.current++
          setDragging(true)
        }
      },
      onDragLeave(event: DragEvent<HTMLDivElement>) {
        if (!files(event)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setDragging(false)
      },
      onDragOver(event: DragEvent<HTMLDivElement>) {
        if (!files(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'
      },
      onDrop(event: DragEvent<HTMLDivElement>) {
        if (!files(event)) return
        event.preventDefault()
        event.stopPropagation()
        clear()
        if (disabled) return
        try {
          const accepted = [...event.dataTransfer.files].filter((file) => {
            const image = file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(file.name)
            const limit = image ? MAX_IMAGE_ATTACHMENT_BYTES : MAX_TEXT_ATTACHMENT_BYTES
            if (file.size <= limit) return true
            push(`Attachment too large: ${file.name}`, 'err')
            return false
          })
          const paths = window.loom.files.pathsForFiles(accepted)
          const ui = useUi.getState()
          const existing = ui.attachmentsBySession[key] ?? []
          const added = [...new Set(paths)].filter((path) => !existing.includes(path))
          if (added.length > MAX_ATTACHMENTS - existing.length)
            push(`Up to ${MAX_ATTACHMENTS} attachments per message`, 'err')
          for (const path of added) ui.addAttachment(key, path)
          if (accepted.length > 0 && paths.length === 0)
            push('Drop files from your computer to attach them', 'err')
          event.currentTarget.querySelector('textarea')?.focus()
        } catch (error) {
          push(`Could not attach files: ${String(error)}`, 'err')
        }
      },
      onDragEnd: clear
    }
  }
}
