import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RawEditor } from './RawEditor.tsx'

vi.mock('./codemirror.ts', () => {
  throw new Error('chunk failed')
})

describe('RawEditor import failure', () => {
  it('shows the failure Alert with Retry when the chunk cannot load', async () => {
    render(<RawEditor value="x" format="raw" />)
    expect(await screen.findByText('The text editor failed to load.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})
