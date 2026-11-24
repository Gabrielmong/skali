import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AllowlistEditor } from './AllowlistEditor.tsx'

const WARNING = 'Lets every device in this range control your servers'

describe('AllowlistEditor', () => {
  it('rejects an invalid address inline and does not add it', async () => {
    const onChange = vi.fn()
    render(<AllowlistEditor value={['192.168.0.5']} onChange={onChange} />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Address or range' }), '999.1.1.1')
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByText(/Enter an IPv4 address/)).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('warns about a /24 range but still allows adding it', async () => {
    const onChange = vi.fn()
    render(<AllowlistEditor value={[]} onChange={onChange} />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Address or range' }), '192.168.0.0/24')
    expect(screen.getByText(WARNING)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(onChange).toHaveBeenCalledWith(['192.168.0.0/24'])
  })

  it('does not warn for a narrow range or a single address', async () => {
    render(<AllowlistEditor value={['10.0.0.5']} onChange={() => {}} />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Address or range' }), '192.168.0.0/25')
    expect(screen.queryByText(WARNING)).toBeNull()
  })

  it('warns on listed wide entries and removes entries', async () => {
    const onChange = vi.fn()
    render(<AllowlistEditor value={['10.0.0.0/8', '192.168.0.5']} onChange={onChange} />)
    expect(screen.getByText(WARNING)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Remove 192.168.0.5' }))
    expect(onChange).toHaveBeenCalledWith(['10.0.0.0/8'])
  })

  it('ignores duplicates', async () => {
    const onChange = vi.fn()
    render(<AllowlistEditor value={['192.168.0.5']} onChange={onChange} />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Address or range' }), '192.168.0.5{Enter}')
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText('Already in the list')).toBeInTheDocument()
  })
})
