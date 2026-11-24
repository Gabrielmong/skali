import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { Console } from './Console.tsx'

vi.mock('../api.ts', async (orig) => ({
  ...(await orig<typeof import('../api.ts')>()),
  getRuns: vi.fn(),
  getRunLog: vi.fn(),
  sendCommand: vi.fn(),
}))

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.getRuns).mockResolvedValue([])
  vi.mocked(api.sendCommand).mockResolvedValue({ output: '' })
})

const renderConsole = (over: Partial<Parameters<typeof Console>[0]> = {}) =>
  render(<Console serverId="s1" lines={['hello world']} hasCommands={true} {...over} />)

function scrollBox(): HTMLElement {
  return screen.getByTestId('console-scroll')
}
function setGeometry(el: HTMLElement, scrollTop: number) {
  Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: 100, configurable: true })
  el.scrollTop = scrollTop
}

describe('Console', () => {
  it('pauses auto-scroll when scrolled up and resumes via the Jump to latest chip', async () => {
    renderConsole()
    await screen.findByText('hello world')
    const box = scrollBox()
    expect(screen.queryByText('Jump to latest')).toBeNull()
    setGeometry(box, 0)
    fireEvent.scroll(box)
    const chip = await screen.findByText('Jump to latest')
    await userEvent.click(chip)
    expect(box.scrollTop).toBe(1000)
    await waitFor(() => expect(screen.queryByText('Jump to latest')).toBeNull())
  })

  it('does not follow new lines while paused', async () => {
    const { rerender } = renderConsole()
    const box = scrollBox()
    setGeometry(box, 0)
    fireEvent.scroll(box)
    await screen.findByText('Jump to latest')
    rerender(<Console serverId="s1" lines={['hello world', 'more']} hasCommands={true} />)
    expect(box.scrollTop).toBe(0)
  })

  it('appends new lines without replacing existing rows, also when the oldest are dropped', () => {
    const { rerender } = renderConsole({ lines: ['a', 'b', 'c'] })
    const b = screen.getByText('b')
    const c = screen.getByText('c')
    rerender(<Console serverId="s1" lines={['a', 'b', 'c', 'd']} hasCommands={true} />)
    expect(screen.getByText('b')).toBe(b)
    rerender(<Console serverId="s1" lines={['b', 'c', 'd', 'e']} hasCommands={true} />)
    expect(screen.getByText('b')).toBe(b)
    expect(screen.getByText('c')).toBe(c)
    expect(screen.queryByText('a')).toBeNull()
  })

  it('does not turn OSC-8 links into anchors', () => {
    const { container } = renderConsole({ lines: ['\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007'] })
    expect(container.querySelector('a')).toBeNull()
  })

  it('dims [skali] lines', () => {
    renderConsole({ lines: ['[skali] Server started', 'plain line'] })
    expect(screen.getByText('[skali] Server started')).toHaveClass('skali-line')
    expect(screen.getByText('plain line')).not.toHaveClass('skali-line')
  })

  it('escapes HTML in log lines', () => {
    const { container } = renderConsole({ lines: ['<img src=x onerror=alert(1)> & <b>bold</b>'] })
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(screen.getByText('<img src=x onerror=alert(1)> & <b>bold</b>')).toBeInTheDocument()
  })

  it('renders ANSI colours as spans', () => {
    const { container } = renderConsole({ lines: ['\u001b[31mred\u001b[0m'] })
    expect(container.querySelector('span[style*="color"]')?.textContent).toBe('red')
  })

  it('filters lines with the search box', async () => {
    renderConsole({ lines: ['alpha one', 'beta two', 'alpha three'] })
    await userEvent.type(screen.getByRole('textbox', { name: 'Search log' }), 'alpha')
    expect(screen.getByText('alpha one')).toBeInTheDocument()
    expect(screen.queryByText('beta two')).toBeNull()
  })

  it('sends a command on Enter and recalls it with ArrowUp', async () => {
    renderConsole()
    const input = screen.getByRole('textbox', { name: 'Command' })
    await userEvent.type(input, 'say hi{Enter}')
    expect(api.sendCommand).toHaveBeenCalledWith('s1', 'say hi')
    await waitFor(() => expect(input).toHaveValue(''))
    await userEvent.type(input, 'list{Enter}')
    await waitFor(() => expect(input).toHaveValue(''))
    await userEvent.keyboard('{ArrowUp}')
    expect(input).toHaveValue('list')
    await userEvent.keyboard('{ArrowUp}')
    expect(input).toHaveValue('say hi')
    await userEvent.keyboard('{ArrowDown}')
    expect(input).toHaveValue('list')
    await userEvent.keyboard('{ArrowDown}')
    expect(input).toHaveValue('')
  })

  it('shows a command error from the server', async () => {
    vi.mocked(api.sendCommand).mockRejectedValue(new api.ApiError(400, 'This server does not accept commands'))
    renderConsole()
    await userEvent.type(screen.getByRole('textbox', { name: 'Command' }), 'x{Enter}')
    expect(await screen.findByText('This server does not accept commands')).toBeInTheDocument()
  })

  it('has no command input when the game takes no commands, and shows help when it does', () => {
    const { unmount } = renderConsole({ hasCommands: false })
    expect(screen.queryByRole('textbox', { name: 'Command' })).toBeNull()
    unmount()
    renderConsole({ commandHelp: 'Try: list' })
    expect(screen.getByText('Try: list')).toBeInTheDocument()
  })

  it('shows an earlier run once with a banner, capped at 5000 lines, and returns to live', async () => {
    vi.mocked(api.getRuns).mockResolvedValue([{ runId: 'r1', startedAt: '2026-01-01T10:00:00.000Z', sizeBytes: 10 }])
    const big = Array.from({ length: 6000 }, (_, i) => `old ${i}`).join('\n') + '\n'
    vi.mocked(api.getRunLog).mockResolvedValue(big)
    renderConsole()
    const select = await screen.findByRole('combobox', { name: 'Previous runs' })
    await waitFor(() => expect(within(select).getAllByRole('option').length).toBe(2))
    await userEvent.selectOptions(select, 'r1')
    expect(await screen.findByText(/Viewing an earlier run/)).toBeInTheDocument()
    expect(await screen.findByText(/last 5000 lines/)).toBeInTheDocument()
    expect(screen.getByText('old 5999')).toBeInTheDocument()
    expect(screen.queryByText('old 999')).toBeNull()
    expect(api.getRunLog).toHaveBeenCalledTimes(1)
    await userEvent.selectOptions(select, '')
    expect(screen.queryByText(/Viewing an earlier run/)).toBeNull()
    expect(screen.getByText('hello world')).toBeInTheDocument()
    await act(async () => {})
  })
})
