import HistoryIcon from '@mui/icons-material/History'
import { Alert, Button, CircularProgress, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material'
import type { ConfigFieldView, ConfigFileView, ConfigSaveResult, ConfigSourceView } from '@skali/shared'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, previewConfig, readConfig, saveConfig } from '../../api.ts'
import { errorMessage } from '../ServerActions.tsx'
import { isChanged, pending, type EditValue, type Edits } from './changes.ts'
import { ConfigForm } from './ConfigForm.tsx'
import { HistoryDialog } from './HistoryDialog.tsx'
import { RawEditor } from './RawEditor.tsx'
import { SaveBar, type SaveError } from './SaveBar.tsx'

interface Props {
  serverId: string
  source: ConfigSourceView
  /** The server process is up, so a saved change needs a restart to apply. */
  running: boolean
  /** A save (or restore) went through; `restart` is true when a running server needs a restart to apply it. */
  onSaved: (restart: boolean) => void
  onDirtyChange: (dirty: boolean) => void
}

const norm = (s: string) => s.replace(/\r\n/g, '\n')
const CANT_SHOW =
  "Your raw edits include changes the form can't show (comments, order, added or removed lines). Save or discard them before editing in the form."

/** The server's message for a stale etag; other 409s (server starting or stopping) are not fixed by reloading. */
const CHANGED_ON_DISK = 'The file changed on disk'

/** One file source: loads it, edits its fields, saves with the etag, and offers history. */

export function FileEditor({ serverId, source, running, onSaved, onDirtyChange }: Props) {
  const [file, setFile] = useState<ConfigFileView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [edits, setEdits] = useState<Edits>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<SaveError | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [mode, setMode] = useState<'form' | 'raw'>('form')
  /** The raw text being edited; null while it is simply the file as read. */
  const [buffer, setBuffer] = useState<string | null>(null)
  /** Fields previewed from raw edits the form can't express; shown read-only. */
  const [locked, setLocked] = useState<ConfigFieldView[] | null>(null)
  const [rawError, setRawError] = useState<string | null>(null)
  const [switching, setSwitching] = useState(false)

  /** Bumped by every toggle, reload, reset, save and edit; a preview is applied only if no bump happened since it started. */
  const gen = useRef(0)
  const invalidate = () => {
    gen.current++
    setSwitching(false)
  }

  /** Counts reads; only the latest one's answer is applied (and none after unmount). */
  const reads = useRef(0)
  const load = useCallback(() => {
    const mine = ++reads.current
    invalidate()
    setLoadError(null)
    setSaveError(null)
    readConfig(serverId, source.id).then(
      (f) => {
        if (reads.current !== mine) return
        setFile(f)
        if (f.fields === null) setMode('raw')
        setEdits({})
        setBuffer(null)
        setLocked(null)
        setRawError(null)
      },
      (e: unknown) => {
        if (reads.current === mine) setLoadError(errorMessage(e))
      },
    )
  }, [serverId, source.id])
  useEffect(() => {
    load()
    return () => {
      reads.current++
    }
  }, [load])

  const fields = file?.fields ?? null
  const p = useMemo(() => (fields ? pending(fields, edits) : null), [fields, edits])
  const rawDirty = file !== null && buffer !== null && norm(buffer) !== norm(file.raw)
  const count = rawDirty ? 1 : (p?.count ?? 0)
  const rawOnly = file !== null && fields === null
  const view = rawOnly ? 'raw' : mode
  useEffect(() => onDirtyChange(count > 0), [count, onDirtyChange])
  // A stale save error must not reappear once the edits that caused it are gone.
  useEffect(() => {
    if (count === 0) setSaveError(null)
  }, [count])

  const applied = (r: ConfigSaveResult) => {
    invalidate()
    if (fields === null) setMode('raw')
    setFile(r.file)
    setEdits({})
    setBuffer(null)
    setLocked(null)
    setRawError(null)
    setSaveError(null)
    onSaved(r.restartPending && running)
  }

  const save = async () => {
    if (!file || (!rawDirty && (!p || p.invalid))) return
    setSaving(true)
    setSaveError(null)
    try {
      const body = rawDirty ? { etag: file.etag, raw: buffer } : { etag: file.etag, changes: p!.changes }
      applied(await saveConfig(serverId, source.id, body))
    } catch (e) {
      setSaveError({ message: errorMessage(e), conflict: e instanceof ApiError && e.status === 409 && e.message.startsWith(CHANGED_ON_DISK) })
    } finally {
      setSaving(false)
    }
  }

  const toRaw = async () => {
    if (!file || !p) return
    setRawError(null)
    const mine = ++gen.current
    if (rawDirty || p.count === 0) {
      setMode('raw')
      return
    }
    if (p.invalid) {
      setRawError('Fix the invalid values in the form first.')
      return
    }
    setSwitching(true)
    try {
      const v = await previewConfig(serverId, source.id, { changes: p.changes })
      if (gen.current !== mine) return
      setBuffer(v.raw)
      setEdits({})
      setMode('raw')
    } catch (e) {
      if (gen.current === mine) setRawError(errorMessage(e))
    } finally {
      if (gen.current === mine) setSwitching(false)
    }
  }

  const toForm = async () => {
    if (!file?.fields) return
    setRawError(null)
    const mine = ++gen.current
    if (!rawDirty) {
      setBuffer(null)
      setLocked(null)
      setMode('form')
      return
    }
    const text = buffer!
    setSwitching(true)
    try {
      const v = await previewConfig(serverId, source.id, { raw: text })
      if (gen.current !== mine) return
      if (v.fields === null) {
        setRawError(v.parseError ?? 'The text does not parse.')
        return
      }
      const diffs: Edits = {}
      for (const f of v.fields) {
        const orig = file.fields.find((o) => o.id === f.id)
        if (orig && isChanged(orig, f.value)) diffs[f.id] = f.value
      }
      const check = await previewConfig(serverId, source.id, { changes: pending(file.fields, diffs).changes })
      if (gen.current !== mine) return
      if (norm(check.raw) === norm(text)) {
        setEdits(diffs)
        setBuffer(null)
        setLocked(null)
      } else {
        setLocked(v.fields)
      }
      setMode('form')
    } catch (e) {
      if (gen.current === mine) setRawError(errorMessage(e))
    } finally {
      if (gen.current === mine) setSwitching(false)
    }
  }

  const onChange = (id: string, value: EditValue) => {
    invalidate()
    setEdits((cur) => ({ ...cur, [id]: value }))
  }

  if (loadError) {
    return (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={load}>
            Retry
          </Button>
        }
      >
        {loadError}
      </Alert>
    )
  }
  if (!file) return <CircularProgress size={24} aria-label="Loading" />

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1, fontFamily: 'monospace', wordBreak: 'break-all' }}>
          {source.path ?? source.label}
        </Typography>
        <Button size="small" startIcon={<HistoryIcon />} onClick={() => setHistoryOpen(true)}>
          History
        </Button>
      </Stack>

      {file.missing && (
        <Alert severity="info">
          This file doesn't exist yet. Saving creates it.
          {file.seededFrom !== undefined && ` Values shown are the defaults from ${file.seededFrom}.`}
        </Alert>
      )}

      <ToggleButtonGroup
        exclusive
        size="small"
        aria-label="View"
        value={view}
        onChange={(_, v: 'form' | 'raw' | null) => {
          if (v === 'raw') void toRaw()
          else if (v === 'form') void toForm()
        }}
        disabled={switching || saving}
        sx={{ alignSelf: 'flex-start' }}
      >
        <ToggleButton value="form" disabled={rawOnly}>
          Form
        </ToggleButton>
        <ToggleButton value="raw">Raw</ToggleButton>
      </ToggleButtonGroup>

      {rawOnly && (
        <Alert severity="warning">
          <div>{file.parseError ?? 'This file cannot be shown as a form.'}</div>
          <div>This file can only be edited as raw text until it parses.</div>
        </Alert>
      )}
      {rawError && <Alert severity="error">{rawError}</Alert>}

      {view === 'raw' ? (
        <RawEditor
          value={buffer ?? file.raw}
          format={file.format}
          readOnly={switching || saving}
          onChange={(t) => {
            invalidate()
            setBuffer(t)
          }}
        />
      ) : (
        <>
          {locked && <Alert severity="warning">{CANT_SHOW}</Alert>}
          <ConfigForm
            fields={locked ?? fields ?? []}
            edits={edits}
            onChange={onChange}
            disabled={saving || switching || locked !== null}
          />
        </>
      )}

      <SaveBar
        count={count}
        rawEdited={rawDirty}
        saving={saving || switching}
        canSave={rawDirty || (p !== null && !p.invalid)}
        error={saveError}
        onReset={() => {
          invalidate()
          setEdits({})
          setBuffer(null)
          setLocked(null)
          setRawError(null)
          setSaveError(null)
        }}
        onSave={() => void save()}
        onReload={load}
      />

      <HistoryDialog
        open={historyOpen}
        serverId={serverId}
        sourceId={source.id}
        format={file.format}
        etag={file.etag}
        onClose={() => setHistoryOpen(false)}
        onRestored={applied}
      />
    </Stack>
  )
}
