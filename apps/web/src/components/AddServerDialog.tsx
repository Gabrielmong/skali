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
  List,
  ListItemButton,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import type { GameId, GameInfo, LaunchValues } from '@skali/shared'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { adoptServer, getGames, inspectFolder, type ValheimWorld } from '../api.ts'
import { FolderPicker } from './FolderPicker.tsx'
import { LaunchFieldsForm, launchFormValid } from './LaunchFieldsForm.tsx'

const ORDER: GameId[] = ['palworld', 'valheim', 'minecraft', 'basic']
const LABELS: Partial<Record<GameId, string>> = { basic: 'Other (basic)' }
const EULA_URL = 'https://aka.ms/MinecraftEULA'

type Step = 'game' | 'folder' | 'details'

const baseName = (folder: string) => folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const worldValue = (w: ValheimWorld, all: ValheimWorld[]) =>
  all.filter((x) => x.name === w.name).length > 1 ? w.fwlPath : w.name

interface Props {
  open: boolean
  onClose: () => void
}

export function AddServerDialog({ open, onClose }: Props) {
  const navigate = useNavigate()
  const [games, setGames] = useState<GameInfo[]>([])
  const [gamesError, setGamesError] = useState<string | null>(null)
  const [step, setStep] = useState<Step>('game')
  const [game, setGame] = useState<GameInfo | null>(null)
  const [folder, setFolder] = useState('')
  const [inspecting, setInspecting] = useState(false)
  const [inspectError, setInspectError] = useState<string | null>(null)
  const [notes, setNotes] = useState<string[]>([])
  const [worlds, setWorlds] = useState<ValheimWorld[]>([])
  const [name, setName] = useState('')
  const [launch, setLaunch] = useState<LaunchValues>({})
  const [world, setWorld] = useState('')
  const [eula, setEula] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    getGames().then(
      (g) => alive && setGames(g),
      (e: unknown) => alive && setGamesError(msg(e)),
    )
    return () => {
      alive = false
    }
  }, [open])

  const sorted = [...games].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id))

  const chooseGame = (g: GameInfo) => {
    setGame(g)
    setInspectError(null)
    setStep('folder')
  }

  const chooseFolder = async (path: string) => {
    if (!game) return
    setInspecting(true)
    setInspectError(null)
    try {
      const res = await inspectFolder(game.id, path)
      if (!res.ok) {
        setInspectError(res.reason)
        return
      }
      const defaults: LaunchValues = {}
      for (const f of game.launchFields) if (f.default !== undefined) defaults[f.key] = f.default
      setFolder(path)
      setNotes(res.notes)
      setWorlds(res.worlds ?? [])
      setWorld('')
      setEula(false)
      setCreateError(null)
      setLaunch({ ...defaults, ...res.launch })
      setName(baseName(path))
      setStep('details')
    } catch (e) {
      setInspectError(msg(e))
    } finally {
      setInspecting(false)
    }
  }

  const needsEula = game?.id === 'minecraft'
  const canCreate = !creating && name.trim() !== '' && (!needsEula || eula) && (!game || launchFormValid(game.launchFields, launch))

  const create = async () => {
    if (!game) return
    setCreating(true)
    setCreateError(null)
    try {
      const server = await adoptServer({
        game: game.id,
        name: name.trim(),
        folder,
        launch,
        ...(world ? { importWorldFrom: world } : {}),
        ...(needsEula ? { acceptEula: true } : {}),
      })
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
      fullWidth maxWidth="sm">
      <DialogTitle>
        Add existing server
        <Typography variant="body2" color="text.secondary">
          {step === 'game' ? 'Step 1 of 3: game' : step === 'folder' ? 'Step 2 of 3: folder' : 'Step 3 of 3: details'}
        </Typography>
      </DialogTitle>
      <DialogContent>
        {step === 'game' && (
          <>
            {gamesError && <Alert severity="error">{gamesError}</Alert>}
            {!gamesError && games.length === 0 && <CircularProgress size={24} />}
            <List>
              {sorted.map((g) => (
                <ListItemButton key={g.id} onClick={() => chooseGame(g)}>
                  <ListItemText primary={LABELS[g.id] ?? g.displayName} />
                </ListItemButton>
              ))}
            </List>
          </>
        )}

        {step === 'folder' && (
          <Stack spacing={1.5} sx={{ pt: 1 }}>
            <Typography variant="body2">
              Pick the folder where {game?.displayName} server is installed (on the server PC).
            </Typography>
            {inspectError && <Alert severity="error">{inspectError}</Alert>}
            <FolderPicker disabled={inspecting} onSelect={(p) => void chooseFolder(p)} />
          </Stack>
        )}

        {step === 'details' && game && (
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="body2" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
              {folder}
            </Typography>
            {notes.map((n) => (
              <Alert key={n} severity="info">
                {n}
              </Alert>
            ))}
            <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} fullWidth required />
            <LaunchFieldsForm fields={game.launchFields} values={launch} onChange={setLaunch} disabled={creating} />
            {game.id === 'valheim' && worlds.length > 0 && (
              <TextField
                select
                label="Import world"
                value={world}
                onChange={(e) => setWorld(e.target.value)}
                slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
                helperText="Copies a world from this PC into the server folder"
                fullWidth
              >
                <option value="">None</option>
                {worlds.map((w) => (
                  <option key={w.fwlPath} value={worldValue(w, worlds)}>
                    {`${w.name} — ${new Date(w.modified).toLocaleString()}`}
                  </option>
                ))}
              </TextField>
            )}
            {needsEula && (
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
            )}
            {createError && <Alert severity="error">{createError}</Alert>}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Box sx={{ flexGrow: 1 }}>
          {step !== 'game' && (
            <Button onClick={() => setStep(step === 'details' ? 'folder' : 'game')} disabled={creating}>
              Back
            </Button>
          )}
        </Box>
        <Button onClick={onClose} disabled={creating}>
          Cancel
        </Button>
        {step === 'details' && (
          <Button variant="contained" disabled={!canCreate} onClick={() => void create()}>
            Create
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}
