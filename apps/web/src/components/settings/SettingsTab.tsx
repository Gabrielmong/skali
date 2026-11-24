import { Alert, Box, Button, CircularProgress, Snackbar, Stack, useMediaQuery, useTheme } from '@mui/material'
import type { ConfigSourceView, GameInfo, ServerView } from '@skali/shared'
import { useCallback, useEffect, useState } from 'react'
import { listConfigSources, removeConfigSource } from '../../api.ts'
import { errorMessage } from '../ServerActions.tsx'
import { AddSourceDialog } from './AddSourceDialog.tsx'
import { FileEditor } from './FileEditor.tsx'
import { LaunchSettings } from './LaunchSettings.tsx'
import { SourceList } from './SourceList.tsx'

const LAUNCH_ID = 'launch'
const DISCARD = 'Discard unsaved changes?'

interface Props {
  server: ServerView
  game: GameInfo | undefined
  /** Restart with the same player confirmation as the card. */
  onRestart: () => void
  /** Tells the page whether unsaved edits exist, so it can guard tab switches. */
  onDirtyChange?: (dirty: boolean) => void
}

export function SettingsTab({ server, game, onRestart, onDirtyChange }: Props) {
  const wide = useMediaQuery(useTheme().breakpoints.up('md'))
  const [sources, setSources] = useState<ConfigSourceView[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState(LAUNCH_ID)
  const [dirty, setDirty] = useState(false)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<'saved' | 'restart' | null>(null)

  useEffect(() => {
    let alive = true
    listConfigSources(server.id).then(
      (s) => alive && setSources(s),
      (e: unknown) => alive && setLoadError(errorMessage(e)),
    )
    return () => {
      alive = false
    }
  }, [server.id])

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange])

  // Closing or reloading the page with unsaved edits asks the browser to confirm.
  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  /** True when it is fine to leave the current source: nothing unsaved, or the user agreed to drop it. */
  const mayLeave = () => !dirty || window.confirm(DISCARD)

  const select = (id: string) => {
    if (id === selectedId || !mayLeave()) return
    setDirty(false)
    setSelectedId(id)
  }

  const remove = async (s: ConfigSourceView) => {
    if (s.id === selectedId && !mayLeave()) return
    try {
      await removeConfigSource(server.id, s.id)
    } catch (e) {
      setError(errorMessage(e))
      return
    }
    setSources((cur) => cur?.filter((x) => x.id !== s.id) ?? cur)
    if (s.id === selectedId) {
      setDirty(false)
      setSelectedId(LAUNCH_ID)
    }
  }

  const added = (s: ConfigSourceView) => {
    setSources((cur) => [...(cur ?? []), s])
    select(s.id)
  }

  const onLaunchDirty = useCallback((d: boolean) => setDirty(d), [])

  if (loadError) return <Alert severity="error">{loadError}</Alert>
  if (!sources) return <CircularProgress size={24} aria-label="Loading" />

  const selected = sources.find((s) => s.id === selectedId) ?? sources[0]

  return (
    <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} sx={{ alignItems: 'flex-start' }}>
      <Box sx={{ width: { xs: '100%', md: 240 }, flexShrink: 0 }}>
        <SourceList
          sources={sources}
          selectedId={selected?.id ?? LAUNCH_ID}
          wide={wide}
          onSelect={select}
          onAdd={() => setAdding(true)}
          onRemove={remove}
        />
      </Box>
      <Box sx={{ flexGrow: 1, minWidth: 0, width: '100%' }}>
        {selected?.kind === 'file' ? (
          <FileEditor
            key={`${server.id}/${selected.id}`}
            serverId={server.id}
            source={selected}
            running={server.status === 'running' || server.status === 'starting'}
            onSaved={(restart) => setToast(restart ? 'restart' : 'saved')}
            onDirtyChange={setDirty}
          />
        ) : (
          <LaunchSettings server={server} game={game} onRestart={onRestart} onDirtyChange={onLaunchDirty} />
        )}
      </Box>
      <AddSourceDialog
        open={adding}
        serverId={server.id}
        folder={server.folder}
        onClose={() => setAdding(false)}
        onAdded={added}
      />
      <Snackbar open={toast === 'saved'} autoHideDuration={2500} onClose={() => setToast(null)} message="Saved" />
      <Snackbar
        open={toast === 'restart'}
        onClose={(_, reason) => reason !== 'clickaway' && setToast(null)}
        message="Saved. Restart now to apply?"
        action={
          <>
            <Button
              color="inherit"
              size="small"
              onClick={() => {
                setToast(null)
                onRestart()
              }}
            >
              Restart now
            </Button>
            <Button color="inherit" size="small" onClick={() => setToast(null)}>
              Later
            </Button>
          </>
        }
      />
      <Snackbar open={error !== null} autoHideDuration={8000} onClose={() => setError(null)}>
        <Alert severity="error" variant="filled" onClose={() => setError(null)}>
          {error}
        </Alert>
      </Snackbar>
    </Stack>
  )
}
