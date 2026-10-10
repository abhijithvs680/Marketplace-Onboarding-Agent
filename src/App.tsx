import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { runOnboardingAgent, VizruError } from './vizru';
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
import { mergeRecord, parseAgentReply, progressOf } from './submission';
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

const FIRST_MESSAGE = 'Hello — we would like to start a partner application.';

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

  useEffect(() => saveTranscript(turns), [turns]);
  useEffect(() => saveRecord(record), [record]);
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
        const parsed = parseAgentReply(reply.text);

        setTurns((prev) => [
          ...prev,
          {
            id: newTurnId(),
            role: 'agent',
            text: parsed.text,
            at: Date.now(),
            captured: parsed.captured.length ? parsed.captured : undefined,
          },
        ]);
        setRecord((prev) => mergeRecord(prev, parsed));
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
    [pending, sessionId],
  );

  const open = useCallback(() => {
    setView('console');
    // A fresh application needs the agent to speak first, and the workflow only
    // answers a message — so the opening turn is sent on the vendor's behalf.
    if (!turns.length) void send(FIRST_MESSAGE);
  }, [send, turns.length]);

  const startNew = useCallback(() => {
    inFlight.current?.abort();
    setSessionId(resetSession());
    setTurns([]);
    setRecord({ captured: {}, submitted: false });
    setDraft('');
    setPending(false);
    setView('welcome');
  }, []);

  if (view === 'welcome') {
    return (
      <div className="app">
        <AppHeader vendor={record.captured.legal_entity} />
        <Welcome hasDraft={turns.length > 0} onStart={open} onStartNew={startNew} />
        <Footer />
      </div>
    );
  }

  if (view === 'review') {
    return (
      <div className="app">
        <AppHeader vendor={record.captured.legal_entity} />
        <Review record={record} sessionId={sessionId} onBack={() => setView('console')} />
        <Footer />
      </div>
    );
  }

  return (
    <div className="app">
      <AppHeader vendor={record.captured.legal_entity} />
      <StageBar progress={progress} />

      <main className="page">
        <div className="page-inner console">
          <section className="card thread-card">
            <div className="card-head card-head--row">
              <div>
                <h1>Onboarding session</h1>
                <p>
                  A specialist walks you through each requirement and records your answers as you
                  go. You can leave and return at any point.
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

      <Footer />
      {notice ? (
        <p className="toast" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <p className="muted">
          © {new Date().getFullYear()} {COMPANY}. Supplier applications are handled by the
          partnerships team.
        </p>
        <nav className="footer-links">
          <a href={`mailto:${SUPPORT_EMAIL}`}>Partner support</a>
          <a href="#privacy">Privacy</a>
          <a href="#terms">Supplier terms</a>
        </nav>
      </div>
    </footer>
  );
}
