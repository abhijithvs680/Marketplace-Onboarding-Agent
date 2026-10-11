import { SUPPORT_EMAIL } from '../brand';
import { FIELDS, type Progress, type SubmissionRecord } from '../submission';

interface Props {
  record: SubmissionRecord;
  progress: Progress;
  onReview: () => void;
  onSaveForLater: () => void;
}

export function SubmissionPanel({ record, progress, onReview, onSaveForLater }: Props) {
  return (
    <aside className="side">
      <section className="card">
        <div className="card-head">
          <h2>Your submission</h2>
          <p>
            {progress.done} of {progress.total} captured, updated as you go.
          </p>
        </div>
        <dl className="fields">
          {FIELDS.map((field) => {
            const value = record.captured[field.id];
            const current = !value && field.stage === progress.stage.id;
            return (
              <div key={field.id} className={`field${value ? ' field--done' : ''}`}>
                {/* Label and status only, as the design canvas has it. The value
                    itself shows on the turn that captured it and on the review
                    page, so the checklist stays a checklist. */}
                <dt title={value ?? undefined}>
                  <span className={current ? 'field-label field-label--current' : 'field-label'}>
                    {field.label}
                  </span>
                </dt>
                <dd>
                  <span
                    className={`status status--${value ? 'done' : current ? 'current' : 'todo'}`}
                  >
                    {value ? 'Captured' : current ? 'In progress' : 'Needed'}
                  </span>
                </dd>
              </div>
            );
          })}
        </dl>
        <div className="card-foot">
          <button type="button" className="btn btn--quiet btn--block" onClick={onReview}>
            Review the application
          </button>
        </div>
      </section>

      <section className="card card--pad">
        <h2>Pause and come back</h2>
        <p className="muted">Reopen this page any time to continue.</p>
        <button type="button" className="btn btn--quiet btn--block" onClick={onSaveForLater}>
          Save and finish later
        </button>
      </section>

      <section className="card card--pad">
        <h2>Need a person?</h2>
        <p className="muted">
          Vendor support answers within one working day:{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </p>
      </section>
    </aside>
  );
}
