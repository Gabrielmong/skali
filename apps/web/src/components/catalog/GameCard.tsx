import StarRoundedIcon from '@mui/icons-material/StarRounded'
import { Box, Card, CardActionArea, Chip, Stack, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import type { CatalogEntry } from '@skali/shared'
import { palette } from '../../theme/tokens.ts'
import { GameArt } from './GameArt.tsx'
import { displayName } from './gameName.ts'

const ease = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

interface Props {
  entry: CatalogEntry
  onSelect: (entry: CatalogEntry) => void
  /** Built-in games: larger title over the art, a Built in badge. */
  featured?: boolean
}

/** A game in the New server gallery: Steam art on top, short name and forwarded ports below. */
export function GameCard({ entry, onSelect, featured = false }: Props) {
  const name = displayName(entry.name)
  const ports = (entry.ports ?? []).filter((p) => p.forward)

  return (
    <Card
      sx={{
        height: '100%',
        overflow: 'hidden',
        transition: `transform 180ms ${ease}, border-color 180ms ${ease}, box-shadow 180ms ${ease}`,
        '&:hover': {
          transform: 'translateY(-3px)',
          borderColor: alpha(palette.frost, 0.45),
          boxShadow: `0 10px 30px ${alpha('#000', 0.35)}, 0 0 0 1px ${alpha(palette.frost, 0.15)}`,
        },
        '&:hover img': { transform: 'scale(1.04)' },
        '& img': { transition: `transform 400ms ${ease}` },
      }}
    >
      <CardActionArea
        aria-label={entry.name}
        onClick={() => onSelect(entry)}
        sx={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}
      >
        <Box sx={{ position: 'relative', overflow: 'hidden' }}>
          <GameArt name={name} art={entry.art} />
          {featured && (
            <>
              <Box
                sx={{ position: 'absolute', inset: 0, background: `linear-gradient(to top, ${alpha(palette.night, 0.92)} 0%, transparent 60%)` }}
              />
              <Chip
                size="small"
                icon={<StarRoundedIcon />}
                label="Built in"
                sx={{
                  position: 'absolute',
                  top: 10,
                  left: 10,
                  color: palette.night,
                  bgcolor: palette.frost,
                  '& .MuiChip-icon': { color: palette.night },
                }}
              />
              <Typography variant="h5" component="span" sx={{ position: 'absolute', left: 16, bottom: 12, right: 16 }} noWrap>
                {name}
              </Typography>
            </>
          )}
        </Box>
        {!featured && (
          <Stack spacing={1} sx={{ p: 1.75, flexGrow: 1 }}>
            <Typography variant="subtitle1" component="span" sx={{ lineHeight: 1.3 }}>
              {name}
            </Typography>
            {ports.length > 0 && (
              <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap', mt: 'auto' }}>
                {ports.map((p) => (
                  <Box
                    key={`${p.protocol}${p.port}`}
                    component="span"
                    title={p.purpose}
                    sx={{
                      fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, monospace',
                      fontSize: 11.5,
                      color: 'text.secondary',
                      px: 0.75,
                      py: 0.25,
                      borderRadius: 1,
                      bgcolor: alpha(palette.line, 0.08),
                    }}
                  >
                    {`${p.protocol.toUpperCase()} ${p.port}`}
                  </Box>
                ))}
              </Stack>
            )}
          </Stack>
        )}
      </CardActionArea>
    </Card>
  )
}
