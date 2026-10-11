import type { CSSProperties } from 'react';
import type { Progress } from '../submission';
import { CheckIcon } from './Icons';

export function StageBar({ progress }: { progress: Progress }) {
  return (
    <nav className="stagebar" aria-label="Application progress">
      <div
        className="stagebar-inner"
        style={{ '--stage-count': progress.stages.length } as CSSProperties}
      >
        {progress.stages.map(({ stage, state }, i) => (
          <div key={stage.id} className={`stage stage--${state}`}>
            <span className="stage-dot" aria-hidden="true">
              {state === 'done' ? <CheckIcon /> : i + 1}
            </span>
            <span className="stage-text">
              <span className="stage-label">{stage.label}</span>
              <span className="stage-state">
                {state === 'done' ? 'Completed' : state === 'current' ? 'In progress' : 'Not started'}
              </span>
            </span>
          </div>
        ))}
        <span className="stage-count">
          Step {progress.step} of {progress.stages.length}
        </span>
      </div>

      {/* The phone layout replaces the rail with a single line and a bar. */}
      <div className="stagebar-compact">
        <div className="stagebar-compact-head">
          <span className="stage-label">{progress.stage.label}</span>
          <span className="stage-count">
            Step {progress.step} of {progress.stages.length}
          </span>
        </div>
        <div
          className="meter"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
          aria-label="Answers captured"
        >
          <span style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
        </div>
        <p className="stagebar-compact-note">
          {progress.done} of {progress.total} answers captured
        </p>
      </div>
    </nav>
  );
}
