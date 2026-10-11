import { SUPPORT_EMAIL } from '../brand';
import {
  FIELDS,
  STAGES,
  isComplete,
  summaryText,
  type SubmissionRecord,
} from '../submission';
import { CheckIcon, DownloadIcon } from './Icons';

interface Props {
  record: SubmissionRecord;
  /** The platform's reference for this application, from GetApplication. */
  reference: string;
  onBack: () => void;
}

const NEXT = [
  {
    title: 'Technical validation',
    body: 'We call your sandbox against the capabilities you listed and come back with anything unclear.',
  },
  {
    title: 'Commercial review',
    body: 'Listing terms, pricing and the supplier agreement, handled by the partnerships team.',
  },
  {
    title: 'Listing goes live',
    body: 'Your product appears in the marketplace catalogue and practices can request a trial.',
  },
];

export function Review({ record, reference, onBack }: Props) {
  const complete = isComplete(record);

  return (
    <main className="page">
      <div className="page-inner review">
        <section className={`banner${record.submitted ? ' banner--done' : ''}`}>
          <div className="banner-main">
            <span className="banner-icon" aria-hidden="true">
              <CheckIcon size={20} />
            </span>
            <div>
              <h1>{record.submitted ? 'Application submitted' : 'Your application so far'}</h1>
              <p>
                {record.submitted
                  ? 'Everything you shared has been filed with the partnerships team.'
                  : complete
                    ? 'Every answer is in. Tell the specialist you are ready and it will file the application.'
                    : 'A draft, saved against this session. Return to the conversation to fill the gaps.'}
              </p>
            </div>
          </div>
          <div className="banner-ref">
            <p className="ref-label">Reference</p>
            <p className="ref-value">{shortRef(reference)}</p>
          </div>
        </section>

        <div className="review-cols">
          <section className="review-main">
            <h2 className="section-head">What you have given us</h2>

            {STAGES.filter((stage) => FIELDS.some((f) => f.stage === stage.id)).map((stage) => (
              <article key={stage.id} className="card">
                <div className="card-head card-head--row">
                  <h3>{stage.label}</h3>
                  <button type="button" className="linkbtn" onClick={onBack}>
                    Change this
                  </button>
                </div>
                <dl className="review-fields">
                  {FIELDS.filter((f) => f.stage === stage.id).map((field) => {
                    const value = record.captured[field.id];
                    return (
                      <div key={field.id}>
                        <dt>{field.label}</dt>
                        <dd className={value ? undefined : 'pending'}>
                          {value ?? 'Not yet provided'}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              </article>
            ))}
          </section>

          <aside className="side">
            <section className="card card--pad">
              <h2>What happens next</h2>
              <ol className="timeline">
                {NEXT.map((item, i) => (
                  <li key={item.title}>
                    <span className="timeline-rail" aria-hidden="true">
                      <span className={i === 0 ? 'node node--on' : 'node'} />
                      {i < NEXT.length - 1 ? <span className="line" /> : null}
                    </span>
                    <span className="timeline-body">
                      <span className="timeline-title">{item.title}</span>
                      <span className="timeline-text">{item.body}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </section>

            <section className="card card--pad stack">
              <button
                type="button"
                className="btn btn--primary btn--block"
                onClick={() => downloadSummary(record, reference)}
              >
                <DownloadIcon />
                Download a copy
              </button>
              <a
                className="btn btn--quiet btn--block"
                href={mailtoSummary(record, reference)}
              >
                Email it to a colleague
              </a>
              <button type="button" className="btn btn--quiet btn--block" onClick={onBack}>
                Back to the conversation
              </button>
              <p className="muted">
                Something wrong? Write to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>{' '}
                quoting the reference above.
              </p>
            </section>
          </aside>
        </div>
      </div>
    </main>
  );
}

/**
 * The platform mints the reference as a uuid. People read it aloud and type it
 * into emails, so show the leading block and keep the full value in the
 * downloaded copy for support to search on.
 */
function shortRef(reference: string): string {
  if (!reference) return '—';
  return reference.split('-')[0].toUpperCase();
}

function downloadSummary(record: SubmissionRecord, reference: string): void {
  const blob = new Blob([`Reference: ${reference}\n\n${summaryText(record)}`], {
    type: 'text/plain;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `vizru-partner-application-${shortRef(reference)}.txt`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function mailtoSummary(record: SubmissionRecord, reference: string): string {
  const subject = `Vizru partner application ${shortRef(reference)}`;
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(
    `Reference: ${reference}\n\n${summaryText(record)}`,
  )}`;
}
