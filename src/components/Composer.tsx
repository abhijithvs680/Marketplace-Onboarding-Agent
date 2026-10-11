import { forwardRef } from 'react';
import { ArrowIcon } from './Icons';

interface Props {
  value: string;
  pending: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
}

export const Composer = forwardRef<HTMLTextAreaElement, Props>(function Composer(
  { value, pending, onChange, onSend },
  ref,
) {
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
    >
      {/* The visible label cost a line of a cramped card; the placeholder and
          the hint below carry the same meaning, so it goes to screen readers. */}
      <label htmlFor="reply" className="sr-only">
        Your reply
      </label>
      <div className="composer-box">
        <textarea
          id="reply"
          ref={ref}
          rows={2}
          value={value}
          placeholder="Answer in your own words…"
          disabled={pending}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
        />
        <button type="submit" className="btn btn--primary" disabled={pending || !value.trim()}>
          {pending ? 'Sending…' : 'Send'}
          <ArrowIcon />
        </button>
      </div>
      <p className="composer-hint">Enter to send · Shift + Enter for a new line</p>
    </form>
  );
});
