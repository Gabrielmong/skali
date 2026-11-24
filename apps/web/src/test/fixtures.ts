import type { ServerView } from '@skali/shared'

export function makeServer(over: Partial<ServerView> = {}): ServerView {
  return {
    id: 's1',
    name: 'Survival',
    game: 'minecraft',
    folder: 'C:\\Games\\mc',
    launch: {},
    desired: 'stopped',
    autoRestart: true,
    autoStart: false,
    stopTimeoutSec: 60,
    pid: null,
    pidStartTime: null,
    currentRunId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'stopped',
    crashPaused: false,
    restartPending: false,
    ports: [],
    connectAddress: '192.168.0.100:25565',
    hasCommands: true,
    ...over,
  }
}
