type Level = 'info' | 'warn' | 'error' | 'ok';
export interface LogEntry { t: number; level: Level; tag: string; msg: string }

let entries: LogEntry[] = [];
const listeners = new Set<() => void>();

export const devLog = {
  info: (tag: string, msg: string) => push('info', tag, msg),
  warn: (tag: string, msg: string) => push('warn', tag, msg),
  error: (tag: string, msg: string) => push('error', tag, msg),
  ok:   (tag: string, msg: string) => push('ok',   tag, msg),
  get entries() { return entries; },
  subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  clear: () => { entries = []; listeners.forEach(fn => fn()); },
};

function push(level: Level, tag: string, msg: string) {
  const entry: LogEntry = { t: Date.now(), level, tag, msg };
  entries = [entry, ...entries.slice(0, 199)];
  // Mirror to real console in dev
  const c = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  c(`[${tag}] ${msg}`);
  listeners.forEach(fn => fn());
}
