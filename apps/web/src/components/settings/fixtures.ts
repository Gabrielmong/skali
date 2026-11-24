import type { ConfigFieldView, ConfigFileView, ConfigSourceView } from '@skali/shared'

export const SOURCES: ConfigSourceView[] = [
  { id: 'launch', kind: 'launch', label: 'Launch settings', builtin: true },
  { id: 'server', kind: 'file', label: 'Server config', path: 'server.properties', format: 'properties', builtin: true },
  { id: 'u1', kind: 'file', label: 'My file', path: 'extra\\my.yml', format: 'yaml', builtin: false },
]

export const FIELDS: ConfigFieldView[] = [
  { id: 'pvp', key: 'pvp', value: true, type: 'switch', label: 'PvP', group: 'Gameplay' },
  { id: 'port', key: 'server-port', value: 25565, type: 'number', label: 'Port', min: 1, max: 65535, group: 'Network' },
  {
    id: 'diff',
    key: 'difficulty',
    value: 'easy',
    type: 'select',
    label: 'Difficulty',
    options: ['peaceful', 'easy', 'hard'],
    group: 'Gameplay',
  },
  { id: 'rcon', key: 'rcon.password', value: 'hunter2', type: 'secret', label: 'RCON password', group: 'Network' },
  {
    id: 'motd',
    key: 'motd',
    value: 'Welcome',
    type: 'text',
    label: 'Message of the day',
    help: 'Shown in the server list',
    group: 'Gameplay',
  },
  {
    id: 'seed',
    key: 'level-seed',
    value: '123',
    type: 'text',
    label: 'World seed',
    locked: 'Changing the seed needs a new world',
  },
]

export const fileView = (over: Partial<ConfigFileView> = {}): ConfigFileView => ({
  sourceId: 'server',
  format: 'properties',
  etag: 'e1',
  raw: 'pvp=true\n',
  fields: FIELDS,
  ...over,
})
