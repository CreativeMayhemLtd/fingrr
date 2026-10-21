// Module-level ATProto agent — set once after login, read by transport services.
// Using module state avoids circular imports between hooks and services.
import type { Agent } from '@atproto/api';

let _agent: Agent | null = null;
export function getAgent(): Agent | null { return _agent; }
export function setAgent(a: Agent | null): void { _agent = a; }
