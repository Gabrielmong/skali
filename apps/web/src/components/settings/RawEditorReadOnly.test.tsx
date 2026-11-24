import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RawEditor } from './RawEditor.tsx'

const spy = vi.hoisted(() => ({ created: 0, destroyed: 0, readOnly: [] as boolean[] }))
vi.mock('./codemirror.ts', () => ({
  createEditor: (parent: HTMLElement, opts: { doc: string; readOnly: boolean }) => {
    spy.created++
    const ta = document.createElement('textarea')
    ta.value = opts.doc
    ta.readOnly = opts.readOnly
    parent.appendChild(ta)
    return {
      setDoc: (t: string) => (ta.value = t),
      setReadOnly: (r: boolean) => {
        spy.readOnly.push(r)
        ta.readOnly = r
      },
      destroy: () => {
        spy.destroyed++
        ta.remove()
      },
    }
  },
}))

describe('RawEditor readOnly', () => {
  it('toggling readOnly reconfigures the editor instead of recreating it', async () => {
    const { rerender } = render(<RawEditor value="a" format="json" />)
    const box = (await screen.findByDisplayValue('a')) as HTMLTextAreaElement
    rerender(<RawEditor value="a" format="json" readOnly />)
    await vi.waitFor(() => expect(box.readOnly).toBe(true))
    rerender(<RawEditor value="a" format="json" />)
    await vi.waitFor(() => expect(box.readOnly).toBe(false))
    expect(spy.created).toBe(1)
    expect(spy.destroyed).toBe(0)
    expect(spy.readOnly).toEqual([true, false])
  })
})
