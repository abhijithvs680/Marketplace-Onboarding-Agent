import { COMPANY } from '../brand';
import { ArrowIcon, CheckIcon } from './Icons';

interface Props {
  hasDraft: boolean;
  onStart: () => void;
  onStartNew: () => void;
}

const NEEDED = [
  'Registered company details and your primary contact',
  'What the product does for a dental practice, and its category',
  'Its regulatory position and whether it handles patient data',
  'Commercial terms: pricing, contract length and support hours',
  'API base URL, authentication method and a technical contact',
];

const STEPS = [
  {
    n: '01',
    title: 'Company & product',
    body: 'Your registered entity and contact, then the product itself: what it is, its category, and what it does for a practice.',
  },
  {
    n: '02',
    title: 'Regulatory & commercial',
    body: 'Whether the product is a regulated medical device, how it handles patient data, and the terms a practice would buy on.',
  },
  {
    n: '03',
    title: 'Integration & review',
    body: 'How our platform talks to yours, then a summary you confirm before it goes to the marketplace team.',
  },
];

export function Welcome({ hasDraft, onStart, onStartNew }: Props) {
  return (
    <main className="page">
      <div className="page-inner welcome">
        <div className="welcome-top">
          <div className="welcome-copy">
            <p className="eyebrow">Vendor application</p>
            <h1>List your product on the dental marketplace</h1>
            <p className="lede">
              A {COMPANY} onboarding manager will take you through the application in a single
              conversation: your company, the product and its regulatory position, the commercial
              terms, and how the two platforms integrate. Answer in your own words — each answer
              is recorded against your application as you give it.
            </p>

            <div className="welcome-actions">
              <button type="button" className="btn btn--primary btn--lg" onClick={onStart}>
                {hasDraft ? 'Resume the application' : 'Start the application'}
                <ArrowIcon size={16} />
              </button>
              {hasDraft ? (
                <button type="button" className="btn btn--quiet btn--lg" onClick={onStartNew}>
                  Start a new application
                </button>
              ) : null}
            </div>

            <p className="muted welcome-note">
              Nothing is listed until the marketplace team has reviewed it with you.
            </p>
          </div>

          <aside className="card card--pad welcome-needs">
            <h2>What to have to hand</h2>
            <p className="muted">You can start without all of it and fill the gaps later.</p>
            <ul className="ticks">
              {NEEDED.map((item) => (
                <li key={item}>
                  <span className="tick" aria-hidden="true">
                    <CheckIcon size={11} />
                  </span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <p className="muted welcome-secure">
              Credentials are never requested in this conversation. Sandbox access is arranged
              later, over a secure channel.
            </p>
          </aside>
        </div>

        <section>
          <h2 className="section-head">How the application runs</h2>
          <ol className="steps">
            {STEPS.map((step) => (
              <li key={step.n} className="card card--pad">
                <span className="step-n">{step.n}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </main>
  );
}
