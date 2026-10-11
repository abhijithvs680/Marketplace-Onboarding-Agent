import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getApplication, getMessages, runOnboardingAgent, startSession, VizruError } from './vizru';
import { COMPANY, SUPPORT_EMAIL } from './brand';
import {
  loadRecord,
  loadSessionId,
  loadTranscript,
  newTurnId,
  resetSession,
  saveRecord,
  saveTranscript,
  type Turn,
} from './session';
import {
  capturedSince,
  EMPTY_RECORD,
  progressOf,
  recordOf,
  type SubmissionRecord,
} from './submission';
import { AppHeader } from './components/AppHeader';
import { Composer } from './components/Composer';
import { Conversation } from './components/Conversation';
import { Review } from './components/Review';
import { StageBar } from './components/StageBar';
import { SubmissionPanel } from './components/SubmissionPanel';
import { Welcome } from './components/Welcome';

type View = 'welcome' | 'console' | 'review';

const OPENERS = [
  'We would like to list our product on the marketplace.',
  'What information do you need from us?',
  'Here are our API details — where should I start?',
];

const FIRST_MESSAGE = 'Hello — we would like to list our product on the dental marketplace.';

export default function App() {
  const [sessionId, setSessionId] = useState(loadSessionId);
  const [turns, setTurns] = useState<Turn[]>(loadTranscript);
  const [record, setRecord] = useState(loadRecord);
  const [view, setView] = useState<View>(() => (loadTranscript().length ? 'console' : 'welcome'));
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const inFlight = useRef<AbortController | null>(null);
  const thread = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);

  // The latest record, for callbacks that need to diff against it without
  // taking it as a dependency (a state updater must stay pure).
  const latest = useRef(record);

  useEffect(() => saveTranscript(turns), [turns]);
  useEffect(() => {
    latest.current = record;
    saveRecord(record);
  }, [record]);
  useEffect(() => () => inFlight.current?.abort(), []);

  useEffect(() => {
    if (view !== 'console') return;
    thread.current?.scrollTo({ top: thread.current.scrollHeight, behavior: 'smooth' });
  }, [turns, pending, view]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  /**
   * Read the application back from the platform and fold it into the record.
   * Returns the turn-sized diff so the conversation can show what was added.
   *
   * A read that fails must never break the conversation: the agent's own reply
   * is the vendor's business, the panel is a mirror of the platform. The
   * developer gets the detail in the console.
   */
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const nothing: ReturnType<typeof capturedSince> = [];
    try {
      const state = await getApplication(sessionId, { signal });
      if (!state) return nothing; // GetApplication not configured yet

      const previous = latest.current;
      const next = recordOf(state, previous);
      latest.current = next;
      setRecord(next);
      return capturedSince(previous, next);
    } catch (err) {
      if (signal?.aborted) return nothing;
      console.warn('[vizru] could not read the application state', err);
      return nothing;
    }
  }, [sessionId]);

  // Once on load, so a returning vendor sees the real state of their
  // application rather than the last thing this browser happened to cache.
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  // The transcript lives on the platform too, so a vendor who comes back on a
  // different machine still sees the conversation. localStorage only ever
  // covered this browser; the platform copy wins when it has anything.
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const stored = await getMessages(sessionId, { signal: controller.signal });
        if (!stored?.length || controller.signal.aborted) return;
        setTurns(
          stored.map((turn) => ({
            id: newTurnId(),
            role: turn.role === 'user' ? ('user' as const) : ('agent' as const),
            text: turn.message,
            at: Date.now(),
          })),
        );
        setView((current) => (current === 'welcome' ? 'console' : current));
      } catch (err) {
        if (!controller.signal.aborted) console.warn('[vizru] could not read the transcript', err);
      }
    })();
    return () => controller.abort();
  }, [sessionId]);

  const progress = useMemo(() => progressOf(record), [record]);

  const send = useCallback(
    async (raw: string) => {
      const message = raw.trim();
      if (!message || pending) return;

      setDraft('');
      setPending(true);
      setTurns((prev) => [
        ...prev.filter((t) => t.role !== 'error'),
        { id: newTurnId(), role: 'user', text: message, at: Date.now() },
      ]);

      const controller = new AbortController();
      inFlight.current = controller;

      try {
        const reply = await runOnboardingAgent({
          message,
          sessionId,
          signal: controller.signal,
        });

        // The agent saves through its tools, so the state it just wrote is read
        // back rather than parsed out of the prose.
        const captured = await refresh(controller.signal);

        setTurns((prev) => [
          ...prev,
          {
            id: newTurnId(),
            role: 'agent',
            text: reply.text,
            at: Date.now(),
            captured: captured.length ? captured : undefined,
          },
        ]);
      } catch (err) {
        if (controller.signal.aborted) return;
        setTurns((prev) => [
          ...prev,
          {
            id: newTurnId(),
            role: 'error',
            text:
              err instanceof VizruError
                ? err.message
                : err instanceof Error
                  ? err.message
                  : `Something went wrong. If it keeps happening, write to ${SUPPORT_EMAIL}.`,
            at: Date.now(),
          },
        ]);
      } finally {
        if (inFlight.current === controller) inFlight.current = null;
        setPending(false);
        input.current?.focus();
      }
    },
    [pending, refresh, sessionId],
  );

  const open = useCallback(() => {
    setView('console');
    if (turns.length) return;

    // A fresh application needs a row on the platform before the agent writes
    // against it, and the agent only answers a message — so the session is
    // opened and the first turn sent on the vendor's behalf.
    void (async () => {
      try {
        const started = await startSession(sessionId);
        if (started?.reference) {
          const next = { ...latest.current, reference: started.reference };
          latest.current = next;
          setRecord(next);
        }
      } catch (err) {
        // A missing reference is cosmetic; the conversation still works and
        // GetApplication will supply one once the session row exists.
        console.warn('[vizru] could not open the session on the platform', err);
      }
      await send(FIRST_MESSAGE);
    })();
  }, [send, sessionId, turns.length]);

  const startNew = useCallback(() => {
    inFlight.current?.abort();
    setSessionId(resetSession());
    setTurns([]);
    latest.current = EMPTY_RECORD;
    setRecord(EMPTY_RECORD);
    setDraft('');
    setPending(false);
    setView('welcome');
  }, []);

  if (view === 'welcome') {
    return (
      <div className="app">
        <AppHeader vendor={record.captured.legal_entity} onNewApplication={startNew} />
        <Welcome hasDraft={turns.length > 0} onStart={open} onStartNew={startNew} />
        <Footer />
      </div>
    );
  }

  if (view === 'review') {
    return (
      <div className="app">
        <AppHeader vendor={record.captured.legal_entity} onNewApplication={startNew} />
        <Review
          record={record}
          reference={referenceOf(record, sessionId)}
          onBack={() => setView('console')}
        />
        <Footer />
      </div>
    );
  }

  return (
    <div className="app">
      <AppHeader vendor={record.captured.legal_entity} onNewApplication={startNew} />
      <StageBar progress={progress} />

      <main className="page page--console">
        <div className="page-inner console">
          <section className="card thread-card">
            <div className="card-head card-head--row">
              <div>
                <h1>Onboarding session</h1>
                <p>
                  An onboarding manager works through each requirement and records your answers
                  as you give them. You can leave and return at any point.
                </p>
              </div>
              <span className="saved">Saved</span>
            </div>

            <Conversation
              ref={thread}
              turns={turns}
              pending={pending}
              suggestions={OPENERS}
              onSuggestion={(text) => void send(text)}
            />

            <Composer
              ref={input}
              value={draft}
              pending={pending}
              onChange={setDraft}
              onSend={() => void send(draft)}
            />
          </section>

          <SubmissionPanel
            record={record}
            progress={progress}
            onReview={() => setView('review')}
            onSaveForLater={() => {
              setView('welcome');
              setNotice('Saved. Reopen this page on the same browser to continue.');
            }}
          />
        </div>
      </main>

      <Footer slim />
      {notice ? (
        <p className="toast" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The platform's reference once it has one. Until StartSession has run — or
 * while its short code is unconfigured — the session id still gives the vendor
 * and support something to quote.
 */
function referenceOf(record: SubmissionRecord, sessionId: string): string {
  return record.reference ?? sessionId.slice(0, 8).toUpperCase();
}

function Footer({ slim = false }: { slim?: boolean }) {
  return (
    <footer className={slim ? 'footer footer--slim' : 'footer'}>
      <div className="footer-inner">
        <p className="muted">
          © {new Date().getFullYear()} {COMPANY}. Vendor applications are reviewed by the dental
          marketplace team.
        </p>
        <nav className="footer-links">
          <a href={`mailto:${SUPPORT_EMAIL}`}>Vendor support</a>
          <a href="#privacy">Privacy</a>
          <a href="#terms">Vendor terms</a>
        </nav>
      </div>
    </footer>
  );
}
