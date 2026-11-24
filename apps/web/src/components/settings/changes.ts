import type { ConfigFieldView } from '@skali/shared'

export type EditValue = string | number | boolean
/** Unsaved edits by field id. A number field's edit stays a string while the user types. */
export type Edits = Record<string, EditValue>

/** The finite number a number-field edit stands for, or null when it is empty or not a number. */
export function parseNumber(v: EditValue): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string' || v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** An error to show under a number field, or null when its edit is fine (or it isn't a number field being edited). */
export function numberProblem(field: ConfigFieldView, edit: EditValue | undefined): string | null {
  if (field.type !== 'number' || edit === undefined) return null
  return parseNumber(edit) === null ? 'Enter a number' : null
}

/** What would be sent for this edit; null when the edit can't be sent (an invalid number). */
function sendable(field: ConfigFieldView, edit: EditValue): EditValue | null {
  if (field.type === 'number') return parseNumber(edit)
  if (field.type === 'switch') return typeof edit === 'boolean' ? edit : String(edit) === 'true'
  return String(edit)
}

/** True when the edit differs from the loaded value (an unparseable number counts as a change that blocks Save). */
export function isChanged(field: ConfigFieldView, edit: EditValue | undefined): boolean {
  if (edit === undefined) return false
  const v = sendable(field, edit)
  if (v === null) return true
  if (field.type === 'number') {
    // INI and properties values arrive as strings ("1.000000"): compare numerically.
    const orig = parseNumber(field.value)
    return orig === null ? true : v !== orig
  }
  if (field.type === 'switch') return v !== (field.value === true || field.value === 'true')
  return String(v) !== String(field.value)
}

export interface Pending {
  /** Only the ids the user actually changed, with the value to send. */
  changes: Record<string, EditValue>
  count: number
  /** A changed number field holds something that isn't a number. */
  invalid: boolean
}

export function pending(fields: ConfigFieldView[], edits: Edits): Pending {
  const changes: Record<string, EditValue> = {}
  let count = 0
  let invalid = false
  for (const f of fields) {
    const edit = edits[f.id]
    if (!isChanged(f, edit)) continue
    count++
    const v = sendable(f, edit as EditValue)
    if (v === null) invalid = true
    else changes[f.id] = v
  }
  return { changes, count, invalid }
}
