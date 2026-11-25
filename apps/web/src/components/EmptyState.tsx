import { Box, LinearProgress, Stack, Typography } from '@mui/material'
import type { ReactNode } from 'react'
import { BrandMark } from '../layout/BrandMark.tsx'

interface Props {
  title: string
  /** Defaults to the brand mark. */
  icon?: ReactNode
  /** Waiting on something (e.g. the live connection): shows a progress bar. */
  busy?: boolean
  children?: ReactNode
}

/** A centred page-level message: empty lists, connecting, not found. */
export function EmptyState({ title, icon, busy = false, children }: Props) {
  return (
    <Stack aria-busy={busy || undefined} spacing={2} sx={{ alignItems: 'center', textAlign: 'center', mt: 10, mx: 'auto', maxWidth: 420 }}>
      <Box sx={{ color: 'text.secondary', display: 'flex' }}>{icon ?? <BrandMark size={48} />}</Box>
      <Typography variant="h5" component="h1">
        {title}
      </Typography>
      {busy && <LinearProgress sx={{ width: 160, borderRadius: 999 }} />}
      {children && (
        <Stack spacing={2} sx={{ alignItems: 'center' }}>
          {children}
        </Stack>
      )}
    </Stack>
  )
}
