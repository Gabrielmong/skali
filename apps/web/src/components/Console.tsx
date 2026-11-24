import DownloadIcon from '@mui/icons-material/Download'
import SearchIcon from '@mui/icons-material/Search'
import { Alert, Box, Button, Chip, InputAdornment, Stack, TextField } from '@mui/material'
import type { RunInfo } from '@skali/shared'
import { AnsiUp } from 'ansi_up'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ApiError, getRunLog, getRuns, runLogUrl, sendCommand } from '../api.ts'

export const MAX_DISPLAY_LINES = 5_000
const HISTORY = 50
const BOTTOM_SLACK_PX = 24
const CACHE_LIMIT = 20_000

const lineCache = new Map<string, string>()

/** One log line as an HTML <div>. The text goes through AnsiUp with escape_html on, so nothing in it is markup. */
function lineHtml(line: string): string {
  const hit = lineCache.get(line)
  if (hit !== undefined) return hit
  // A fresh instance per line: colour state must not leak from one line into the next (lines are cached).
  const ansi = new AnsiUp()
  ansi.escape_html = true
  const body = ansi.ansi_to_html(line.replace(/\r/g, ''))
  const html = `<div class="${line.startsWith('[skali] ') ? 'l skali-line' : 'l'}">${body}</div>`
  if (lineCache.size >= CACHE_LIMIT) lineCache.clear()
  lineCache.set(line, html)
  return html
}

function toLines(text: string): { lines: string[]; total: number } {
  const all = text.split(/\r?\n/)
  if (all.length > 0 && all[all.length - 1] === '') all.pop()
  return { lines: all.length > MAX_DISPLAY_LINES ? all.slice(all.length - MAX_DISPLAY_LINES) : all, total: all.length }
}

interface Props {
  serverId: string
  /** The live log (already capped by the live layer). */
  lines: string[]
  /** The run the live lines belong to; used for the download button and to refresh the run list. */
  liveRunId?: string
  hasCommands: boolean
  commandHelp?: string
}

interface Earlier {
  runId: string
  loading: boolean
  lines: string[]
  total: number
  error: string | null
}

const runLabel = (r: RunInfo) =>
  `${new Date(r.startedAt).toLocaleString()} (${Math.max(1, Math.round(r.sizeBytes / 1024))} KB)`

export function Console({ serverId, lines, liveRunId, hasCommands, commandHelp }: Props) {
  const [runs, setRuns] = useState<RunInfo[]>([])
  const [earlier, setEarlier] = useState<Earlier | null>(null)
  const [search, setSearch] = useState('')
  const [showJump, setShowJump] = useState(false)
  const [command, setCommand] = useState('')
  const [commandError, setCommandError] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const history = useRef<string[]>([])
  const histIdx = useRef<number | null>(null)
  const draft = useRef('')
  const loadToken = useRef(0)

  useEffect(() => {
    let alive = true
    getRuns(serverId).then(
      (r) => alive && setRuns(r),
      () => alive && setRuns([]),
    )
    return () => {
      alive = false
    }
  }, [serverId, liveRunId])

  // Another server, or a fresh mount: back to the live view.
  useEffect(() => {
    loadToken.current++
    setEarlier(null)
    pinned.current = true
    setShowJump(false)
  }, [serverId])

  const shown = earlier ? earlier.lines : lines
  const html = useMemo(() => {
    const q = search.trim().toLowerCase()
    const visible = q ? shown.filter((l) => l.toLowerCase().includes(q)) : shown
    return visible.map(lineHtml).join('')
  }, [shown, search])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [html])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX
    pinned.current = atBottom
    setShowJump(!atBottom)
  }

  const jumpToLatest = () => {
    const el = scrollRef.current
    pinned.current = true
    setShowJump(false)
    if (el) el.scrollTop = el.scrollHeight
  }

  const selectRun = (runId: string) => {
    const token = ++loadToken.current
    if (runId === '') {
      setEarlier(null)
      jumpToLatest()
      return
    }
    setEarlier({ runId, loading: true, lines: [], total: 0, error: null })
    pinned.current = true
    getRunLog(serverId, runId).then(
      (text) => {
        if (loadToken.current !== token) return
        const { lines: l, total } = toLines(text)
        setEarlier({ runId, loading: false, lines: l, total, error: null })
      },
      (e: unknown) => {
        if (loadToken.current !== token) return
        const message = e instanceof Error ? e.message : String(e)
        setEarlier({ runId, loading: false, lines: [], total: 0, error: message })
      },
    )
  }

  const submit = () => {
    const cmd = command.trim()
    if (!cmd) return
    history.current = [...history.current, cmd].slice(-HISTORY)
    histIdx.current = null
    draft.current = ''
    setCommand('')
    setCommandError(null)
    // The output arrives through the log stream.
    sendCommand(serverId, cmd).catch((e: unknown) => {
      setCommandError(e instanceof ApiError || e instanceof Error ? e.message : String(e))
      setCommand((cur) => (cur === '' ? cmd : cur))
    })
  }

  const onCommandKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const h = history.current
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    } else if (e.key === 'ArrowUp') {
      if (h.length === 0) return
      e.preventDefault()
      if (histIdx.current === null) {
        draft.current = command
        histIdx.current = h.length - 1
      } else {
        histIdx.current = Math.max(0, histIdx.current - 1)
      }
      setCommand(h[histIdx.current]!)
    } else if (e.key === 'ArrowDown') {
      if (histIdx.current === null) return
      e.preventDefault()
      if (histIdx.current < h.length - 1) {
        histIdx.current++
        setCommand(h[histIdx.current]!)
      } else {
        histIdx.current = null
        setCommand(draft.current)
      }
    }
  }

  const downloadRun = earlier?.runId ?? liveRunId

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <TextField
          size="small"
          label="Search log"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          sx={{ minWidth: 220 }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
        />
        <TextField
          select
          size="small"
          label="Previous runs"
          value={earlier?.runId ?? ''}
          onChange={(e) => selectRun(e.target.value)}
          sx={{ minWidth: 260 }}
          slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
        >
          <option value="">Current run</option>
          {runs.map((r) => (
            <option key={r.runId} value={r.runId}>
              {runLabel(r)}
            </option>
          ))}
        </TextField>
        <Box sx={{ flexGrow: 1 }} />
        {downloadRun ? (
          <Button
            component="a"
            href={runLogUrl(serverId, downloadRun)}
            download
            startIcon={<DownloadIcon />}
            size="small"
          >
            Download
          </Button>
        ) : (
          <Button disabled startIcon={<DownloadIcon />} size="small">
            Download
          </Button>
        )}
      </Stack>

      {earlier && (
        <Alert
          severity={earlier.error ? 'error' : 'info'}
          action={
            <Button color="inherit" size="small" onClick={() => selectRun('')}>
              Back to current run
            </Button>
          }
        >
          {earlier.error
            ? `Viewing an earlier run: ${earlier.error}`
            : earlier.loading
              ? 'Viewing an earlier run: loading…'
              : earlier.total > MAX_DISPLAY_LINES
                ? `Viewing an earlier run. Showing only the last ${MAX_DISPLAY_LINES} lines (of ${earlier.total}); download it for the rest.`
                : 'Viewing an earlier run'}
        </Alert>
      )}

      <Box sx={{ position: 'relative' }}>
        <Box
          ref={scrollRef}
          data-testid="console-scroll"
          onScroll={onScroll}
          sx={{
            height: 'min(60vh, 600px)',
            minHeight: 240,
            overflow: 'auto',
            p: 1,
            bgcolor: '#101214',
            color: '#d6d6d6',
            borderRadius: 1,
            fontFamily: 'ui-monospace, Consolas, "Cascadia Mono", monospace',
            fontSize: 13,
            lineHeight: 1.45,
            '& .l': { whiteSpace: 'pre-wrap', wordBreak: 'break-all', minHeight: '1.45em' },
            '& .skali-line': { opacity: 0.55 },
          }}
        >
          <div dangerouslySetInnerHTML={{ __html: html }} />
        </Box>
        {showJump && (
          <Chip
            label="Jump to latest"
            color="primary"
            onClick={jumpToLatest}
            sx={{ position: 'absolute', right: 16, bottom: 12 }}
          />
        )}
      </Box>

      {hasCommands && (
        <>
          <TextField
            size="small"
            label="Command"
            value={command}
            onChange={(e) => {
              setCommand(e.target.value)
              histIdx.current = null
            }}
            onKeyDown={onCommandKey}
            helperText={commandHelp}
            fullWidth
            autoComplete="off"
            slotProps={{ htmlInput: { style: { fontFamily: 'monospace' }, maxLength: 1000 } }}
          />
          {commandError && (
            <Alert severity="error" onClose={() => setCommandError(null)}>
              {commandError}
            </Alert>
          )}
        </>
      )}
    </Stack>
  )
}
