import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import { IconButton, Stack, Tooltip, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { palette } from '../theme/tokens.ts'

/** The address players connect to, in a subtle mono box with a copy button. */
export function AddressChip({ address, onCopy }: { address: string; onCopy: () => void }) {
  return (
    <Stack
      direction="row"
      sx={{
        alignItems: 'center',
        alignSelf: 'flex-start',
        maxWidth: '100%',
        pl: 1,
        borderRadius: 1.5,
        bgcolor: alpha(palette.line, 0.07),
        border: `1px solid ${alpha(palette.line, 0.1)}`,
      }}
    >
      <Typography
        variant="body2"
        noWrap
        sx={{ fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, monospace', fontSize: 13, color: 'text.primary' }}
      >
        {address}
      </Typography>
      <Tooltip title="Copy address">
        <IconButton size="small" aria-label="Copy address" onClick={onCopy} sx={{ color: 'text.secondary' }}>
          <ContentCopyIcon sx={{ fontSize: 15 }} />
        </IconButton>
      </Tooltip>
    </Stack>
  )
}
