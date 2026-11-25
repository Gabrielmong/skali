import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Link as MuiLink,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material'
import type { CatalogEntry, GameInfo, InstallRequest, LaunchValues, MinecraftFlavour, PortClash } from '@skali/shared'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { checkPorts, getGames, getSettings, installServer, minecraftVersions } from '../../api.ts'
import { FolderPicker } from '../FolderPicker.tsx'
import { parsePort, PortsField, type PortRow } from './PortsField.tsx'

const EULA_URL = 'https://aka.ms/MinecraftEULA'
const NAME_RE = /^[A-Za-z0-9 _.-]{1,40}$/
const PAL_TEXT_MAX = 128
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/
const PORT_DEBOUNCE_MS = 400

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const joinPath = (root: string, name: string) => (root === '' ? '' : root.endsWith('\\') ? root + name : `${root}\\${name}`)

interface PortDef {
  key: string
  label: string
  protocol: 'udp' | 'tcp'
  span?: number
  fallback: number
}

/** The launch keys that hold ports for each game (mirrors the server-side adapters' `ports`). */
const PORT_DEFS: Record<string, PortDef[]> = {
  palworld: [
    { key: 'port', label: 'Port', protocol: 'udp', fallback: 8211 },
    { key: 'restPort', label: 'REST API port', protocol: 'tcp', fallback: 8212 },
  ],
  valheim: [{ key: 'port', label: 'Port', protocol: 'udp', span: 3, fallback: 2456 }],
  minecraft: [
    { key: 'port', label: 'Port', protocol: 'tcp', fallback: 25565 },
    { key: 'rconPort', label: 'RCON port', protocol: 'tcp', fallback: 25575 },
  ],
}

const fieldDefault = (info: GameInfo | undefined, key: string, fallback: number) => {
  const d = info?.launchFields.find((f) => f.key === key)?.default
  return typeof d === 'number' ? d : fallback
}

interface Props {
  open: boolean
  entry: CatalogEntry
  onClose: () => void
}

export function SetupDialog({ open, entry, onClose }: Props) {
  const navigate = useNavigate()
  const game = entry.game
  const [info, setInfo] = useState<GameInfo | undefined>()
  const [loaded, setLoaded] = useState(false)
  const [gamesRoot, setGamesRoot] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [folderOverride, setFolderOverride] = useState<string | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [portText, setPortText] = useState<Record<string, string>>({})

  const [palName, setPalName] = useState('')
  const [palPassword, setPalPassword] = useState('')
  const [palMax, setPalMax] = useState('32')

  const [world, setWorld] = useState('Dedicated')
  const [valPassword, setValPassword] = useState('')
  const [isPublic, setIsPublic] = useState(true)
  const [crossplay, setCrossplay] = useState(false)

  const [flavour, setFlavour] = useState<MinecraftFlavour>('vanilla')
  const [versions, setVersions] = useState<string[]>([])
  const [version, setVersion] = useState('')
  const [versionsError, setVersionsError] = useState<string | null>(null)
  const [memory, setMemory] = useState('4096')
  const [eula, setEula] = useState(false)

  const [checked, setChecked] = useState<{ key: string; clashes: PortClash[] }>({ key: '', clashes: [] })
  const [checkError, setCheckError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    Promise.all([getGames(), getSettings()]).then(
      ([g, s]) => {
        if (!alive) return
        setInfo(g.find((x) => x.id === game))
        setGamesRoot(s.gamesRoot)
        setLoaded(true)
      },
      (e: unknown) => {
        if (!alive) return
        setLoadError(msg(e))
        setLoaded(true)
      },
    )
    return () => {
      alive = false
    }
  }, [open, game])

  useEffect(() => {
    if (!open || game !== 'minecraft') return
    let alive = true
    setVersions([])
    setVersion('')
    setVersionsError(null)
    minecraftVersions(flavour).then(
      (v) => {
        if (!alive) return
        setVersions(v.versions)
        setVersion(v.latest || v.versions[0] || '')
      },
      (e: unknown) => alive && setVersionsError(msg(e)),
    )
    return () => {
      alive = false
    }
  }, [open, game, flavour])

  const rows: PortRow[] = useMemo(() => {
    if (game === 'basic') {
      return (entry.ports ?? []).map((p, i) => ({
        id: `p${i}`,
        label: p.purpose ? `${p.purpose} port` : 'Port',
        protocol: p.protocol,
        value: portText[`p${i}`] ?? String(p.port),
        span: 1,
      }))
    }
    return (PORT_DEFS[game] ?? []).map((d) => ({
      id: d.key,
      label: d.label,
      protocol: d.protocol,
      value: portText[d.key] ?? String(fieldDefault(info, d.key, d.fallback)),
      span: d.span,
    }))
  }, [game, entry.ports, info, portText])

  const portsValid = rows.every((r) => parsePort(r) !== null)
  const portsKey = useMemo(
    () =>
      JSON.stringify(
        rows.flatMap((r) => {
          const n = parsePort(r)
          return n === null ? [] : Array.from({ length: r.span ?? 1 }, (_, i) => ({ port: n + i, protocol: r.protocol }))
        }),
      ),
    [rows],
  )

  useEffect(() => {
    if (!open || !loaded || !portsValid) return
    const list = JSON.parse(portsKey) as { port: number; protocol: 'udp' | 'tcp' }[]
    if (list.length === 0) return
    let alive = true
    const t = setTimeout(() => {
      checkPorts(list).then(
        (r) => {
          if (!alive) return
          setChecked({ key: portsKey, clashes: r.clashes })
          setCheckError(null)
        },
        (e: unknown) => {
          if (!alive) return
          setChecked({ key: portsKey, clashes: [] })
          setCheckError(msg(e))
        },
      )
    }, PORT_DEBOUNCE_MS)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [open, loaded, portsValid, portsKey])

  // Clashes only count for the exact ports they were checked for; while a newer check is pending the server's own check at Create decides.
  const clashes = checked.key === portsKey ? checked.clashes : []

  const trimmedName = name.trim()
  const nameOk = NAME_RE.test(trimmedName)
  const folder = folderOverride ?? joinPath(gamesRoot, trimmedName)

  const palMaxNum = /^\d+$/.test(palMax.trim()) ? Number(palMax) : NaN
  const palNameProblem =
    palName.length > PAL_TEXT_MAX || CONTROL_RE.test(palName) ? `One line, at most ${PAL_TEXT_MAX} characters` : null
  const palPwProblem =
    palPassword.length > PAL_TEXT_MAX || CONTROL_RE.test(palPassword) ? `One line, at most ${PAL_TEXT_MAX} characters` : null
  const palMaxOk = palMaxNum >= 1 && palMaxNum <= 32
  const valPwOk = valPassword.length >= 5
  const memoryNum = /^\d+$/.test(memory.trim()) ? Number(memory) : NaN
  const memoryOk = memoryNum >= 1024

  const gameOk =
    game === 'palworld'
      ? palName.trim() !== '' && !palNameProblem && !palPwProblem && palMaxOk
      : game === 'valheim'
        ? world.trim() !== '' && valPwOk
        : game === 'minecraft'
          ? eula && version !== '' && memoryOk
          : game === 'basic'
            ? entry.appId !== null
            : false

  const canCreate =
    !creating && loaded && nameOk && folder.trim() !== '' && portsValid && clashes.length === 0 && gameOk

  const buildRequest = (): InstallRequest => {
    const port = (id: string) => Number(rows.find((r) => r.id === id)?.value)
    const base = { game, name: trimmedName, folder: folder.trim() }
    if (game === 'palworld') {
      return {
        ...base,
        launch: { port: port('port'), restPort: port('restPort') },
        palworld: { serverName: palName, serverPassword: palPassword, maxPlayers: palMaxNum },
      }
    }
    if (game === 'valheim') {
      const launch: LaunchValues = { port: port('port'), world: world.trim(), password: valPassword, public: isPublic, crossplay }
      return { ...base, launch }
    }
    if (game === 'minecraft') {
      return {
        ...base,
        launch: { port: port('port'), rconPort: port('rconPort'), memoryMb: memoryNum },
        minecraft: { flavour, version },
        acceptEula: true,
      }
    }
    const launch: LaunchValues = rows.length > 0 ? { ports: rows.map((r) => `${r.value.trim()}/${r.protocol}`).join(', ') } : {}
    return { ...base, launch, appId: entry.appId ?? undefined }
  }

  const create = async () => {
    setCreating(true)
    setCreateError(null)
    try {
      const server = await installServer(buildRequest())
      onClose()
      navigate(`/servers/${encodeURIComponent(server.id)}`)
    } catch (e) {
      setCreateError(msg(e))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={(_e, reason) => {
        if (reason === 'backdropClick' || creating) return
        onClose()
      }}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle>
        Set up {entry.name}
        <Typography variant="body2" color="text.secondary">
          Skáli downloads the server files and sets it up for you.
        </Typography>
      </DialogTitle>
      <DialogContent>
        {!loaded ? (
          <CircularProgress size={24} />
        ) : (
          <Stack spacing={2} sx={{ pt: 1 }}>
            {loadError && <Alert severity="error">{loadError}</Alert>}
            <TextField
              label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              fullWidth
              error={trimmedName !== '' && !nameOk}
              helperText={
                trimmedName !== '' && !nameOk ? 'Up to 40 letters, numbers, spaces, dots, dashes or underscores' : undefined
              }
            />
            <Stack spacing={1}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                <TextField
                  label="Install folder"
                  value={folder}
                  onChange={(e) => setFolderOverride(e.target.value === '' ? null : e.target.value)}
                  helperText="On the server PC. Must be new or empty."
                  fullWidth
                />
                <Button sx={{ mt: 1 }} onClick={() => setBrowsing((b) => !b)}>
                  {browsing ? 'Hide' : 'Browse'}
                </Button>
              </Stack>
              {browsing && (
                <FolderPicker
                  onSelect={(p) => {
                    setFolderOverride(p)
                    setBrowsing(false)
                  }}
                />
              )}
            </Stack>

            {game === 'palworld' && (
              <>
                <TextField
                  label="Server name"
                  value={palName}
                  onChange={(e) => setPalName(e.target.value)}
                  required
                  fullWidth
                  error={!!palNameProblem}
                  helperText={palNameProblem ?? undefined}
                />
                <TextField
                  label="Password (optional)"
                  type="password"
                  value={palPassword}
                  onChange={(e) => setPalPassword(e.target.value)}
                  fullWidth
                  autoComplete="new-password"
                  error={!!palPwProblem}
                  helperText={palPwProblem ?? undefined}
                />
                <TextField
                  label="Max players"
                  value={palMax}
                  onChange={(e) => setPalMax(e.target.value)}
                  fullWidth
                  error={!palMaxOk}
                  helperText={palMaxOk ? undefined : 'Enter a number from 1 to 32'}
                  slotProps={{ htmlInput: { inputMode: 'numeric' } }}
                />
              </>
            )}

            {game === 'valheim' && (
              <>
                <TextField
                  label="World name"
                  value={world}
                  onChange={(e) => setWorld(e.target.value)}
                  required
                  fullWidth
                />
                <TextField
                  label="Password"
                  type="password"
                  value={valPassword}
                  onChange={(e) => setValPassword(e.target.value)}
                  required
                  fullWidth
                  autoComplete="new-password"
                  error={valPassword !== '' && !valPwOk}
                  helperText="At least 5 characters, and it can't contain the server name"
                />
                <FormControlLabel
                  control={<Switch checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />}
                  label="Public server"
                />
                <FormControlLabel
                  control={<Switch checked={crossplay} onChange={(e) => setCrossplay(e.target.checked)} />}
                  label="Crossplay"
                />
              </>
            )}

            {game === 'minecraft' && (
              <>
                <TextField
                  select
                  label="Flavour"
                  value={flavour}
                  onChange={(e) => setFlavour(e.target.value as MinecraftFlavour)}
                  slotProps={{ select: { native: true } }}
                  fullWidth
                >
                  <option value="vanilla">Vanilla</option>
                  <option value="paper">Paper</option>
                </TextField>
                <TextField
                  select
                  label="Version"
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
                  error={!!versionsError}
                  helperText={versionsError ?? (versions.length === 0 ? 'Loading versions…' : undefined)}
                  fullWidth
                >
                  {versions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </TextField>
                <TextField
                  label="Memory (MB)"
                  value={memory}
                  onChange={(e) => setMemory(e.target.value)}
                  fullWidth
                  error={!memoryOk}
                  helperText={memoryOk ? undefined : 'At least 1024'}
                  slotProps={{ htmlInput: { inputMode: 'numeric' } }}
                />
                <FormControlLabel
                  control={<Checkbox checked={eula} onChange={(e) => setEula(e.target.checked)} />}
                  label={
                    <>
                      I accept the{' '}
                      <MuiLink href={EULA_URL} target="_blank" rel="noopener noreferrer">
                        Minecraft EULA
                      </MuiLink>
                    </>
                  }
                />
              </>
            )}

            {rows.length > 0 && (
              <Box>
                <Typography variant="subtitle2" sx={{ mb: 1 }}>
                  Ports
                </Typography>
                <PortsField
                  rows={rows}
                  clashes={clashes}
                  disabled={creating}
                  onChange={(id, v) => setPortText((t) => ({ ...t, [id]: v }))}
                />
                {checkError && (
                  <Typography variant="caption" color="text.secondary">
                    Couldn&apos;t check the ports now ({checkError}); Skáli checks again when you create the server.
                  </Typography>
                )}
              </Box>
            )}
            {game === 'basic' && (
              <Typography variant="body2" color="text.secondary">
                You&apos;ll confirm the program and its arguments after the files are installed.
              </Typography>
            )}
            {createError && <Alert severity="error">{createError}</Alert>}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={creating}>
          Cancel
        </Button>
        <Button variant="contained" disabled={!canCreate} onClick={() => void create()}>
          Create
        </Button>
      </DialogActions>
    </Dialog>
  )
}
