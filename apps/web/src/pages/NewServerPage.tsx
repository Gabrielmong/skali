import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import SearchIcon from '@mui/icons-material/Search'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Divider,
  InputAdornment,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { alpha } from '@mui/material/styles'
import type { CatalogEntry } from '@skali/shared'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import { ApiError, getCatalog, steamAppInfo } from '../api.ts'
import { GameCard } from '../components/catalog/GameCard.tsx'
import { displayName } from '../components/catalog/gameName.ts'
import { SetupDialog } from '../components/setup/SetupDialog.tsx'
import { palette } from '../theme/tokens.ts'

const MAX_APP_ID = 2 ** 31
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

const gridOf = (min: number) =>
  ({ display: 'grid', gap: 2, gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${min}px), 1fr))` }) as const

type Lookup =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'found'; entry: CatalogEntry; windows: boolean }
  | { state: 'error'; message: string }

/** A titled gallery section (a region named by its heading) with a count badge and a one-line hint. */
function Section({ title, count, hint, children }: { title: string; count: number; hint: string; children: ReactNode }) {
  const id = useId()
  return (
    <Box component="section" aria-labelledby={id}>
      <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', mb: 0.25 }}>
        <Typography id={id} variant="h6" component="h2">
          {title}
        </Typography>
        <Box
          component="span"
          sx={{
            fontSize: 12,
            fontWeight: 700,
            color: 'text.secondary',
            px: 1,
            py: 0.125,
            borderRadius: 999,
            bgcolor: alpha(palette.line, 0.1),
          }}
        >
          {count}
        </Box>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {hint}
      </Typography>
      {children}
    </Box>
  )
}

export function NewServerPage() {
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [appId, setAppId] = useState('')
  const [lookup, setLookup] = useState<Lookup>({ state: 'idle' })
  const lookupSeq = useRef(0)
  const [selected, setSelected] = useState<CatalogEntry | null>(null)
  const otherId = useId()

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
  const shown = (catalog ?? []).filter(
    (e) => q === '' || e.name.toLowerCase().includes(q) || displayName(e.name).toLowerCase().includes(q),
  )
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
    <Stack spacing={4}>
      <Stack spacing={2}>
        <Box>
          <Typography variant="h4" component="h1">
            New server
          </Typography>
          <Typography color="text.secondary">Pick a game and Skáli installs and sets up the server.</Typography>
        </Box>
        <TextField
          label="Search games"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          fullWidth
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ color: 'text.secondary' }} />
                </InputAdornment>
              ),
              sx: { bgcolor: alpha(palette.surface, 0.85) },
            },
          }}
        />
      </Stack>

      {error && <Alert severity="error">{error}</Alert>}
      {!error && catalog === null && (
        <Box aria-busy sx={gridOf(230)}>
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} variant="rounded" sx={{ height: 'auto', aspectRatio: '460 / 290', borderRadius: 2.5 }} />
          ))}
        </Box>
      )}

      {stars.length > 0 && (
        <Section title="Built in" count={stars.length} hint="Full support: tailored settings, console and config files">
          <Box sx={gridOf(300)}>
            {stars.map((e) => (
              <GameCard key={e.name} entry={e} featured onSelect={setSelected} />
            ))}
          </Box>
        </Section>
      )}

      {others.length > 0 && (
        <Section title="Steam servers" count={others.length} hint="Installed with SteamCMD and run as a generic server">
          <Box sx={gridOf(230)}>
            {others.map((e) => (
              <GameCard key={`${e.appId}`} entry={e} onSelect={setSelected} />
            ))}
          </Box>
        </Section>
      )}

      {catalog !== null && shown.length === 0 && (
        <Typography color="text.secondary" sx={{ textAlign: 'center', py: 4 }}>
          {`No games match “${search.trim()}”.`}
        </Typography>
      )}

      <Card component="section" aria-labelledby={otherId}>
        <CardContent>
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            spacing={{ xs: 3, md: 4 }}
            divider={<Divider flexItem orientation="vertical" sx={{ display: { xs: 'none', md: 'block' } }} />}
          >
            <Stack spacing={1.5} sx={{ flex: 1 }}>
              <Box>
                <Typography id={otherId} variant="h6" component="h2">
                  Other Steam dedicated server
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Not in the list? Look it up by its Steam app ID.
                </Typography>
              </Box>
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
                  <Typography sx={{ fontWeight: 600 }}>{lookup.entry.name}</Typography>
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

            <Stack spacing={1.5} sx={{ flex: 1, alignItems: 'flex-start' }}>
              <Box>
                <Typography variant="h6" component="h2">
                  Already installed?
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Point Skáli at a server folder you already have.
                </Typography>
              </Box>
              <Button component={Link} to="/add" variant="outlined" startIcon={<FolderOpenIcon />}>
                Add an existing folder instead
              </Button>
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      {selected && <SetupDialog open entry={selected} onClose={() => setSelected(null)} />}
    </Stack>
  )
}
