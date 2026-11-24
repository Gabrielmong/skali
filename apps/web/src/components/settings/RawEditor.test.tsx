import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { RawEditor } from './RawEditor.tsx'

let failures = 1
vi.mock('./codemirror.ts', () => ({
  createEditor: (parent: HTMLElement, opts: { doc: string }) => {
    if (failures-- > 0) throw new Error('boom')
    const ta = document.createElement('textarea')
    ta.value = opts.doc
    parent.appendChild(ta)
    return { setDoc: (t: string) => (ta.value = t), setReadOnly: (r: boolean) => (ta.readOnly = r), destroy: () => ta.remove() }
  },
}))

describe('RawEditor', () => {
  it('shows an Alert instead of a spinner when the editor fails to start, and Retry recovers', async () => {
    render(<RawEditor value="hello" format="json" />)
    expect(await screen.findByText('The text editor failed to load.')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByDisplayValue('hello')).toBeInTheDocument()
    expect(screen.queryByText('The text editor failed to load.')).toBeNull()
  })
})
