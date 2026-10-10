import { COMPANY } from '../brand';
import { ArrowIcon, CheckIcon } from './Icons';

interface Props {
  hasDraft: boolean;
  onStart: () => void;
  onStartNew: () => void;
}

const NEEDED = [
  'Your registered company name and trading address',
  'A short summary of what your product does for a practice',
  'Your API base URL and the authentication method it uses',
  'A technical contact we can reach during integration',
];

const STEPS = [
  {
    n: '01',
    title: 'Company profile',
    body: 'Who you are, where you trade, and who we should speak to about commercial and technical matters.',
  },
  {
    n: '02',
    title: 'Product & features',
    body: 'The capabilities your application exposes to a dental practice, and the problems each one solves.',
  },
  {
    n: '03',
    title: 'API & integration',
    body: 'How our platform talks to yours: endpoints, authentication, and the environments we can test against.',
  },
];

export function Welcome({ hasDraft, onStart, onStartNew }: Props) {
  return (
    <main className="page">
      <div className="page-inner welcome">
        <div className="welcome-top">
          <div className="welcome-copy">
            <p className="eyebrow">Supplier application</p>
            <h1>List your product on the marketplace</h1>
            <p className="lede">
              An onboarding specialist will take you through the application in a single
              conversation — company details, what your product does, and how {COMPANY} will
              integrate with your platform. Answer in your own words; it will ask for anything
              still missing and record each answer as you go.
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
              Nothing is published until our commercial team reviews it with you.
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
              Sandbox credentials are requested later, over a secure channel — never in this
              conversation.
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
