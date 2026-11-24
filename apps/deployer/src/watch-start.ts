import type { History } from './history.js';
import type { OpContext } from './op-context.js';

/**
 * A copy of `ctx` whose history reports the first event an operation starts, so a command can
 * answer with the event id while the operation itself keeps running in the background.
 */
export function watchStart(ctx: OpContext): { ctx: OpContext; started: Promise<string> } {
  let resolve!: (id: string) => void;
  const started = new Promise<string>((r) => (resolve = r));
  const history = new Proxy(ctx.history, {
    get(target, prop) {
      if (prop === 'start') {
        return (e: Parameters<History['start']>[0]) => {
          const ev = target.start(e);
          resolve(ev.id);
          return ev;
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ctx: { ...ctx, history }, started };
}
