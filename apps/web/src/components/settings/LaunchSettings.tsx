import { Alert, Box, Button, Snackbar, Stack, Typography } from '@mui/material'
import type { FieldSpec, GameInfo, LaunchValues, ServerView } from '@skali/shared'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { patchServer, type ServerPatch } from '../../api.ts'
import { LaunchFieldsForm, launchFormValid } from '../LaunchFieldsForm.tsx'
import { ErrorSnackbar, errorMessage } from '../ServerActions.tsx'

interface Props {
  server: ServerView
  game: GameInfo | undefined
  /** Restart with the same player confirmation as the card. */
  onRestart: () => void
  onDirtyChange: (dirty: boolean) => void
}

/** Only the keys the game declares: the server rejects any other launch key. */
function declaredOnly(launch: LaunchValues, fields: FieldSpec[]): LaunchValues {
  const out: LaunchValues = {}
  for (const f of fields) if (launch[f.key] !== undefined) out[f.key] = launch[f.key]!
  return out
}

const sameLaunch = (a: LaunchValues, b: LaunchValues) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
const sortKeys = (o: LaunchValues) => Object.fromEntries(Object.entries(o).sort(([x], [y]) => x.localeCompare(y)))

/** The "Launch settings" source: the game's launch fields, saved through PATCH /api/servers/:id. */
export function LaunchSettings({ server, game, onRestart, onDirtyChange }: Props) {
  const fields = useMemo(() => game?.launchFields ?? [], [game])
  const saved = useMemo(() => declaredOnly(server.launch, fields), [server.launch, fields])
  const [values, setValues] = useState<LaunchValues>(saved)
  const [saving, setSaving] = useState(false)
  const [needsRestart, setNeedsRestart] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // `baseline` is the last server copy the form was reconciled with; unsaved edits survive server updates.
  const [baseline, setBaseline] = useState(saved)
  const [seen, setSeen] = useState(saved)
  if (seen !== saved) {
    if (sameLaunch(values, baseline)) setValues(saved)
    setBaseline(saved)
    setSeen(saved)
  }

  const dirty = !sameLaunch(values, baseline)
  const valid = launchFormValid(fields, values)
  const running = server.status === 'running' || server.status === 'starting' || server.status === 'stopping'
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])

  const patch = useCallback(
    async (p: ServerPatch) => {
      try {
        return await patchServer(server.id, p)
      } catch (e) {
        setError(errorMessage(e))
        return null
      }
    },
    [server.id],
  )

  const save = async () => {
    setSaving(true)
    const view = await patch({ launch: values })
    setSaving(false)
    if (!view) return
    // The view masks passwords again; drop any plaintext the user typed.
    const next = declaredOnly(view.launch, fields)
    setValues(next)
    setBaseline(next)
    if (running) setNeedsRestart(true)
    else setToast('Saved')
  }

  return (
    <Stack spacing={2} sx={{ maxWidth: 480 }}>
      {fields.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          This game has no launch settings.
        </Typography>
      ) : (
        <LaunchFieldsForm fields={fields} values={values} onChange={setValues} disabled={saving} />
      )}
      {needsRestart && (
        <Alert
          severity="info"
          action={
            <Button
              color="inherit"
              size="small"
              onClick={() => {
                setNeedsRestart(false)
                onRestart()
              }}
            >
              Restart
            </Button>
          }
          onClose={() => setNeedsRestart(false)}
        >
          Takes effect on next start. Restart now?
        </Alert>
      )}
      {fields.length > 0 && (
        <Box>
          <Button variant="contained" disabled={!dirty || !valid || saving} onClick={() => void save()}>
            Save
          </Button>
        </Box>
      )}
      <Snackbar open={toast !== null} autoHideDuration={2500} onClose={() => setToast(null)} message={toast} />
      <ErrorSnackbar error={error} onClose={() => setError(null)} />
    </Stack>
  )
}
