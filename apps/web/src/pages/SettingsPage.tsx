import { Alert, Box, Button, CircularProgress, Snackbar, Stack, TextField, Typography } from '@mui/material'
import { useEffect, useState } from 'react'
import type { ToolsStatus } from '@skali/shared'
import { getSettings, getTools, putSettings, type AppSettings } from '../api.ts'
import { AllowlistEditor } from '../components/AllowlistEditor.tsx'
import { errorMessage } from '../components/ServerActions.tsx'

const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/

/** Basic sanity check; the server has the final say. */
export function connectHostError(host: string): string | null {
  const h = host.trim()
  if (h === '') return 'Enter the address people use to reach this PC'
  if (h.length > 253 || !HOST.test(h)) return 'Enter a host name or IP address, without http:// or a port'
  return null
}

export function SettingsPage() {
  const [saved, setSaved] = useState<AppSettings | null>(null)
  const [allowlist, setAllowlist] = useState<string[]>([])
  const [connectHost, setConnectHost] = useState('')
  const [gamesRoot, setGamesRoot] = useState('')
  const [tools, setTools] = useState<ToolsStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [toast, setToast] = useState(false)

  useEffect(() => {
    let alive = true
    getSettings().then(
      (s) => {
        if (!alive) return
        setSaved(s)
        setAllowlist(s.allowlist)
        setConnectHost(s.connectHost)
        setGamesRoot(s.gamesRoot)
      },
      (e: unknown) => alive && setLoadError(errorMessage(e)),
    )
    // Informational only: the page works without it.
    getTools().then(
      (t) => alive && setTools(t),
      () => undefined,
    )
    return () => {
      alive = false
    }
  }, [])

  if (loadError) return <Alert severity="error">{loadError}</Alert>
  if (!saved) return <CircularProgress aria-label="Loading settings" />

  const hostError = connectHostError(connectHost)
  const rootError = gamesRoot.trim() === '' ? 'Enter a folder path' : null
  const dirty =
    connectHost.trim() !== saved.connectHost ||
    gamesRoot.trim() !== saved.gamesRoot ||
    JSON.stringify(allowlist) !== JSON.stringify(saved.allowlist)

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const out = await putSettings({ allowlist, connectHost: connectHost.trim(), gamesRoot: gamesRoot.trim() })
      setSaved(out)
      setAllowlist(out.allowlist)
      setConnectHost(out.connectHost)
      setGamesRoot(out.gamesRoot)
      setToast(true)
    } catch (e) {
      setSaveError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Stack spacing={3} sx={{ maxWidth: 640 }}>
      <Typography variant="h5">Settings</Typography>

      <Box>
        <Typography variant="subtitle1">Devices allowed to use Skáli</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Only these IPv4 addresses and ranges can open this page or control your servers. This PC is always allowed.
        </Typography>
        <AllowlistEditor value={allowlist} onChange={setAllowlist} />
      </Box>

      <TextField
        label="Connect host"
        value={connectHost}
        onChange={(e) => setConnectHost(e.target.value)}
        error={hostError !== null}
        helperText={hostError ?? 'Shown in each server\'s connect address, for example 192.168.0.100'}
        fullWidth
      />

      <TextField
        label="Games folder"
        value={gamesRoot}
        onChange={(e) => setGamesRoot(e.target.value)}
        error={rootError !== null}
        helperText={rootError ?? 'New servers are installed in a folder here, for example D:\\GameServers'}
        fullWidth
      />

      <Box>
        <Typography variant="subtitle1">Tools</Typography>
        {tools ? (
          <>
            <Typography variant="body2">
              {tools.steamcmd ? 'SteamCMD: installed' : 'SteamCMD: not installed yet (downloaded on first install)'}
            </Typography>
            <Typography variant="body2">
              {tools.java.length > 0 ? `Java: ${tools.java.join(', ')}` : 'Java: none yet'}
            </Typography>
          </>
        ) : (
          <Typography variant="body2" color="text.secondary">
            Checking…
          </Typography>
        )}
      </Box>

      {saveError && <Alert severity="error">{saveError}</Alert>}
      <Box>
        <Button variant="contained" disabled={!dirty || saving || hostError !== null || rootError !== null} onClick={() => void save()}>
          Save
        </Button>
      </Box>
      <Snackbar open={toast} autoHideDuration={2500} onClose={() => setToast(false)} message="Saved" />
    </Stack>
  )
}
