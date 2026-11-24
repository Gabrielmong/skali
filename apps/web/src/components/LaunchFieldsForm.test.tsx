import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FieldSpec } from '@skali/shared'
import { describe, expect, it, vi } from 'vitest'
import { LaunchFieldsForm } from './LaunchFieldsForm.tsx'

const fields: FieldSpec[] = [
  { key: 'public', label: 'Public', type: 'switch', help: 'Show in the community list' },
  { key: 'password', label: 'Password', type: 'password' },
  { key: 'players', label: 'Max players', type: 'number', min: 1, max: 32 },
  { key: 'name', label: 'Server name', type: 'text' },
]

describe('LaunchFieldsForm', () => {
  it('renders a switch for switch fields, and shows help', () => {
    render(<LaunchFieldsForm fields={fields} values={{ public: true }} onChange={() => {}} />)
    expect(screen.getByRole('switch', { name: 'Public' })).toBeChecked()
    expect(screen.getByText('Show in the community list')).toBeInTheDocument()
  })

  it('masks passwords and can reveal them', async () => {
    render(<LaunchFieldsForm fields={fields} values={{ password: 'hunter2' }} onChange={() => {}} />)
    const input = screen.getByLabelText('Password')
    expect(input).toHaveAttribute('type', 'password')
    await userEvent.click(screen.getByRole('button', { name: 'Show password' }))
    expect(input).toHaveAttribute('type', 'text')
  })

  it('uses min/max on number fields and reports numeric changes', async () => {
    const onChange = vi.fn()
    render(<LaunchFieldsForm fields={fields} values={{ players: 4 }} onChange={onChange} />)
    const input = screen.getByRole('spinbutton', { name: 'Max players' })
    expect(input).toHaveAttribute('min', '1')
    expect(input).toHaveAttribute('max', '32')
    await userEvent.type(input, '0')
    expect(onChange).toHaveBeenLastCalledWith({ players: 40 })
  })

  it('reports text and switch changes', async () => {
    const onChange = vi.fn()
    render(<LaunchFieldsForm fields={fields} values={{ public: false, name: '' }} onChange={onChange} />)
    await userEvent.click(screen.getByRole('switch', { name: 'Public' }))
    expect(onChange).toHaveBeenLastCalledWith({ public: true, name: '' })
    await userEvent.type(screen.getByRole('textbox', { name: 'Server name' }), 'a')
    expect(onChange).toHaveBeenLastCalledWith({ public: false, name: 'a' })
  })
})
