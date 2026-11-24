import { Box, Typography } from '@mui/material'
import { useEffect, useRef } from 'react'

/** The selected event's log, scrolled to the end as it grows. */
export function DeployLog({ text, empty }: { text: string | null; empty?: string }) {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [text])
  if (text === null || text === '') {
    return (
      <Typography variant="body2" color="text.secondary">
        {empty ?? 'No log yet.'}
      </Typography>
    )
  }
  return (
    <Box
      component="pre"
      ref={ref}
      aria-label="Deploy log"
      sx={{
        m: 0,
        p: 1.5,
        maxHeight: { xs: 320, md: 560 },
        overflow: 'auto',
        bgcolor: 'action.hover',
        borderRadius: 1,
        fontFamily: 'monospace',
        fontSize: 13,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {text}
    </Box>
  )
}
