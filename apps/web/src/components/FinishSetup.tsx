import { Alert, Button, Paper, Stack, Typography } from '@mui/material'
import type { GameInfo, LaunchValues, ServerView } from '@skali/shared'
import { useState } from 'react'
import { patchServer } from '../api.ts'
import { LaunchFieldsForm, launchFormValid } from './LaunchFieldsForm.tsx'
import { errorMessage } from './ServerActions.tsx'

/** Shown on Overview while `setupPending`: confirm the program and launch settings of a freshly installed basic server. */
export function FinishSetup({ server, game }: { server: ServerView; game: GameInfo | undefined }) {
  const [values, setValues] = useState<LaunchValues>(server.launch)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fields = game?.launchFields ?? []
  const running = server.job?.state === 'running'

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await patchServer(server.id, { launch: values })
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2} sx={{ maxWidth: 560 }}>
        <Typography variant="subtitle1">Finish setup</Typography>
        <Typography variant="body2" color="text.secondary">
          The game files are installed. Choose the program to run and how to start it, then save.
        </Typography>
        <LaunchFieldsForm fields={fields} values={values} onChange={setValues} disabled={saving || running} />
        {error && <Alert severity="error">{error}</Alert>}
        <div>
          <Button
            variant="contained"
            disabled={saving || running || !launchFormValid(fields, values)}
            onClick={() => void save()}
          >
            Save
          </Button>
        </div>
      </Stack>
    </Paper>
  )
}
