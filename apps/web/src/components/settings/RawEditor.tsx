import { Alert, Box, Button, LinearProgress, useTheme } from '@mui/material'
import type { ConfigFormat } from '@skali/shared'
import { useEffect, useRef, useState } from 'react'
import type { Editor } from './codemirror.ts'

interface Props {
  value: string
  format: ConfigFormat
  readOnly?: boolean
  onChange?: (text: string) => void
}

const norm = (s: string) => s.replace(/\r\n/g, '\n')

/** A CodeMirror text view, loaded on first use. `value` is the text to show; edits are reported through onChange. */
export function RawEditor({ value, format, readOnly = false, onChange }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<Editor | null>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const dark = useTheme().palette.mode === 'dark'
  // The latest text the editor holds, so a `value` that merely echoes an edit does not reset the document.
  const current = useRef(value)
  const appliedRO = useRef(readOnly)
  const latest = useRef({ value, onChange, readOnly })
  latest.current = { value, onChange, readOnly }

  useEffect(() => {
    let alive = true
    let made: Editor | null = null
    setFailed(false)
    import('./codemirror.ts')
      .then(({ createEditor }) => {
        if (!alive || !host.current) return
        current.current = latest.current.value
        made = createEditor(host.current, {
          doc: latest.current.value,
          format,
          readOnly: latest.current.readOnly,
          dark,
          onChange: (text) => {
            current.current = text
            latest.current.onChange?.(text)
          },
        })
        appliedRO.current = latest.current.readOnly
        editor.current = made
        setReady(true)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
      made?.destroy()
      editor.current = null
      setReady(false)
    }
  }, [format, dark, attempt])

  useEffect(() => {
    if (editor.current && appliedRO.current !== readOnly) {
      appliedRO.current = readOnly
      editor.current.setReadOnly(readOnly)
    }
  }, [readOnly, ready])

  useEffect(() => {
    if (editor.current && norm(value) !== norm(current.current)) {
      current.current = value
      editor.current.setDoc(value)
    }
  }, [value, ready])

  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden', minHeight: 48 }}>
      {failed && (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </Button>
          }
        >
          The text editor failed to load.
        </Alert>
      )}
      {!ready && !failed && <LinearProgress aria-label="Loading editor" />}
      <div ref={host} />
    </Box>
  )
}
