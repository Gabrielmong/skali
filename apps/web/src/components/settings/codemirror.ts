// The only module that imports @codemirror/*; RawEditor loads it lazily so the editor stays out of the main bundle.
import { json } from '@codemirror/lang-json'
import { yaml } from '@codemirror/lang-yaml'
import { StreamLanguage, type LanguageSupport } from '@codemirror/language'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { Compartment } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { basicSetup, EditorView } from 'codemirror'
import type { ConfigFormat } from '@skali/shared'

export interface EditorOptions {
  doc: string
  format: ConfigFormat
  readOnly: boolean
  dark: boolean
  onChange(text: string): void
}

export interface Editor {
  setDoc(text: string): void
  setReadOnly(readOnly: boolean): void
  destroy(): void
}

function language(format: ConfigFormat): LanguageSupport | StreamLanguage<unknown> | null {
  switch (format) {
    case 'json':
      return json()
    case 'yaml':
      return yaml()
    case 'ini':
    case 'palworld':
    case 'properties':
      return StreamLanguage.define(properties)
    default:
      return null
  }
}

export function createEditor(parent: HTMLElement, opts: EditorOptions): Editor {
  const lang = language(opts.format)
  const readOnly = new Compartment()
  const ro = (on: boolean) => EditorView.editable.of(!on)
  const view = new EditorView({
    parent,
    doc: opts.doc,
    extensions: [
      basicSetup,
      ...(opts.dark ? [oneDark] : []),
      EditorView.theme({ '&': { maxHeight: '60vh', fontSize: '13px' }, '.cm-scroller': { overflow: 'auto' } }),
      ...(lang ? [lang] : []),
      readOnly.of(ro(opts.readOnly)),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) opts.onChange(u.state.doc.toString())
      }),
    ],
  })
  return {
    setDoc(text) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
    },
    setReadOnly(on) {
      view.dispatch({ effects: readOnly.reconfigure(ro(on)) })
    },
    destroy: () => view.destroy(),
  }
}
