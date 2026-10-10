/**
 * The session id is the agent's `thread_id`. The Agent Node has memory = "true",
 * so the whole transcript lives server-side keyed by this value — which means it
 * must survive a reload, and starting a genuinely new application means minting
 * a new one.
 *
 * The transcript and the submission record kept here are the UI's copy; the
 * agent's own memory is the source of truth for what it knows.
 */

import { EMPTY_RECORD, type Field, type SubmissionRecord } from './submission';

const SESSION_KEY = 'vizru.onboarding.sessionId';
const TRANSCRIPT_KEY = 'vizru.onboarding.transcript';
const RECORD_KEY = 'vizru.onboarding.record';

export type Role = 'user' | 'agent' | 'error';

export interface Turn {
  id: string;
  role: Role;
  text: string;
  at: number;
  /** Fields this reply reported — rendered as the "Added to your submission" card. */
  captured?: Array<{ field: Field; value: string }>;
}

export function loadSessionId(): string {
  const stored = read(SESSION_KEY);
  if (stored) return stored;
  const fresh = mintId();
  write(SESSION_KEY, fresh);
  return fresh;
}

export function resetSession(): string {
  const fresh = mintId();
  write(SESSION_KEY, fresh);
  write(TRANSCRIPT_KEY, '[]');
  write(RECORD_KEY, JSON.stringify(EMPTY_RECORD));
  return fresh;
}

export function loadTranscript(): Turn[] {
  const parsed = readJson<Turn[]>(TRANSCRIPT_KEY);
  return Array.isArray(parsed) ? parsed : [];
}

export function saveTranscript(turns: Turn[]): void {
  // Errors are UI noise, not conversation — the agent never saw them.
  write(TRANSCRIPT_KEY, JSON.stringify(turns.filter((t) => t.role !== 'error')));
}

export function loadRecord(): SubmissionRecord {
  const parsed = readJson<SubmissionRecord>(RECORD_KEY);
  if (!parsed || typeof parsed !== 'object' || typeof parsed.captured !== 'object') {
    return EMPTY_RECORD;
  }
  return { captured: parsed.captured ?? {}, submitted: Boolean(parsed.submitted) };
}

export function saveRecord(record: SubmissionRecord): void {
  write(RECORD_KEY, JSON.stringify(record));
}

export function newTurnId(): string {
  return mintId();
}

function mintId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Private windows and blocked site data make these throw, and an application
// that cannot remember locally is still usable — the agent remembers server-side.
function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readJson<T>(key: string): T | null {
  const raw = read(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}
