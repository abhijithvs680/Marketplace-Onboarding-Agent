import { forwardRef } from 'react';
import type { Turn } from '../session';
import { CheckIcon, SpecialistIcon } from './Icons';
import { RichText } from './RichText';

interface Props {
  turns: Turn[];
  pending: boolean;
  onSuggestion: (text: string) => void;
  /** Shown under the first agent message while the vendor has said nothing yet. */
  suggestions: string[];
}

export const Conversation = forwardRef<HTMLDivElement, Props>(function Conversation(
  { turns, pending, onSuggestion, suggestions },
  ref,
) {
  const showSuggestions = !pending && !turns.some((t) => t.role === 'user');

  return (
    <div className="thread" ref={ref}>
      <ol className="turns">
        {turns.map((turn) =>
          turn.role === 'user' ? (
            <li key={turn.id} className="turn turn--user">
              <p className="turn-who">You</p>
              <div className="bubble bubble--user">{turn.text}</div>
            </li>
          ) : turn.role === 'error' ? (
            <li key={turn.id} className="turn turn--error">
              <p className="turn-who">Not sent</p>
              <div className="bubble bubble--error">{turn.text}</div>
            </li>
          ) : (
            <li key={turn.id} className="turn turn--agent">
              <span className="speaker" aria-hidden="true">
                <SpecialistIcon />
              </span>
              <div className="turn-body">
                <p className="turn-who">Onboarding Agent</p>
                {turn.text ? (
                  <div className="bubble bubble--agent">
                    <RichText text={turn.text} />
                  </div>
                ) : null}
                {turn.captured?.length ? (
                  <div className="record">
                    <p className="record-head">
                      <CheckIcon size={12} />
                      Added to your submission
                    </p>
                    <dl className="record-fields">
                      {turn.captured.map(({ field, value }) => (
                        <div key={field.id}>
                          <dt>{field.label}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ) : null}
              </div>
            </li>
          ),
        )}

        {pending ? (
          <li className="turn turn--agent" aria-live="polite">
            <span className="speaker" aria-hidden="true">
              <SpecialistIcon />
            </span>
            <div className="turn-body">
              <p className="turn-who">Onboarding Agent</p>
              <div className="bubble bubble--agent thinking">
                <i />
                <i />
                <i />
                <span className="sr-only">Working on a reply</span>
              </div>
            </div>
          </li>
        ) : null}
      </ol>

      {showSuggestions ? (
        <div className="suggestions">
          {suggestions.map((text) => (
            <button key={text} type="button" className="chip" onClick={() => onSuggestion(text)}>
              {text}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
});
