import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EmptyState } from './EmptyState.tsx'

describe('EmptyState', () => {
  it('shows its title as the page heading with the content beneath', () => {
    render(
      <EmptyState title="No servers yet">
        <p>Add a game server</p>
      </EmptyState>,
    )
    expect(screen.getByRole('heading', { level: 1, name: 'No servers yet' })).toBeInTheDocument()
    expect(screen.getByText('Add a game server')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('shows progress while busy', () => {
    render(<EmptyState title="Connecting to Skáli…" busy />)
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
  })
})
