import StarIcon from '@mui/icons-material/Star'
import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  CircularProgress,
  Divider,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import type { CatalogEntry } from '@skali/shared'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { ApiError, getCatalog, steamAppInfo } from '../api.ts'
import { SetupDialog } from '../components/setup/SetupDialog.tsx'

const MAX_APP_ID = 2 ** 31
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

type Lookup =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'found'; entry: CatalogEntry; windows: boolean }
  | { state: 'error'; message: string }

export function NewServerPage() {
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [appId, setAppId] = useState('')
  const [lookup, setLookup] = useState<Lookup>({ state: 'idle' })
  const lookupSeq = useRef(0)
  const [selected, setSelected] = useState<CatalogEntry | null>(null)

  useEffect(() => {
    let alive = true
    getCatalog().then(
      (c) => alive && setCatalog(c),
      (e: unknown) => alive && setError(msg(e)),
    )
    return () => {
      alive = false
    }
  }, [])

  const q = search.trim().toLowerCase()
  const shown = (catalog ?? []).filter((e) => q === '' || e.name.toLowerCase().includes(q))
  const stars = shown.filter((e) => e.star)
  const others = shown.filter((e) => !e.star)

  const idNum = /^\d+$/.test(appId.trim()) ? Number(appId) : NaN
  const idOk = Number.isSafeInteger(idNum) && idNum >= 1 && idNum <= MAX_APP_ID

  const doLookup = async () => {
    if (!idOk) return
    const seq = ++lookupSeq.current
    setLookup({ state: 'busy' })
    try {
      const info = await steamAppInfo(idNum)
      if (seq !== lookupSeq.current) return
      setLookup({
        state: 'found',
        windows: info.windows,
        entry: { appId: info.appId, game: 'basic', name: info.name, star: false },
      })
    } catch (e) {
      if (seq !== lookupSeq.current) return
      setLookup({
        state: 'error',
        message: e instanceof ApiError && e.status === 404 ? 'No Steam app with that ID' : msg(e),
      })
    }
  }

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5">New server</Typography>
        <Typography color="text.secondary">Pick a game and Skáli installs and sets up the server.</Typography>
      </Box>
      <TextField
        label="Search games"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        fullWidth
      />
      {error && <Alert severity="error">{error}</Alert>}
      {!error && catalog === null && <CircularProgress size={24} />}
      {stars.length > 0 && (
        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
          {stars.map((e) => (
            <Card key={e.name} variant="outlined">
              <CardActionArea onClick={() => setSelected(e)} aria-label={e.name}>
                <CardContent>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <StarIcon fontSize="small" color="warning" />
                    <Typography variant="h6">{e.name}</Typography>
                  </Stack>
                </CardContent>
              </CardActionArea>
            </Card>
          ))}
        </Box>
      )}
      {others.length > 0 && (
        <List dense sx={{ border: 1, borderColor: 'divider', borderRadius: 1, maxHeight: 360, overflow: 'auto' }}>
          {others.map((e) => (
            <ListItemButton key={`${e.appId}`} onClick={() => setSelected(e)}>
              <ListItemText primary={e.name} />
            </ListItemButton>
          ))}
        </List>
      )}
      {catalog !== null && shown.length === 0 && <Typography color="text.secondary">No games match.</Typography>}

      <Divider />
      <Stack spacing={1.5}>
        <Typography variant="subtitle1">Other Steam dedicated server</Typography>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
          <TextField
            label="Other Steam app ID"
            value={appId}
            onChange={(e) => {
              lookupSeq.current++
              setAppId(e.target.value)
              setLookup({ state: 'idle' })
            }}
            slotProps={{ htmlInput: { inputMode: 'numeric' } }}
            size="small"
          />
          <Button variant="outlined" disabled={!idOk || lookup.state === 'busy'} onClick={() => void doLookup()}>
            Look up
          </Button>
        </Stack>
        {lookup.state === 'busy' && <CircularProgress size={20} />}
        {lookup.state === 'found' && (
          <Stack spacing={0.5}>
            <Typography>{lookup.entry.name}</Typography>
            {!lookup.windows && (
              <Typography color="error">No Windows build — this server can&apos;t run here</Typography>
            )}
          </Stack>
        )}
        {lookup.state === 'error' && <Typography color="error">{lookup.message}</Typography>}
        {lookup.state !== 'idle' && lookup.state !== 'busy' && (
          <Box>
            <Button
              variant="contained"
              disabled={lookup.state !== 'found' || !lookup.windows}
              onClick={() => lookup.state === 'found' && lookup.entry.appId === idNum && setSelected(lookup.entry)}
            >
              Set up
            </Button>
          </Box>
        )}
      </Stack>

      <Box>
        <Button component={Link} to="/add">
          Add an existing folder instead
        </Button>
      </Box>

      {selected && <SetupDialog open entry={selected} onClose={() => setSelected(null)} />}
    </Stack>
  )
}
