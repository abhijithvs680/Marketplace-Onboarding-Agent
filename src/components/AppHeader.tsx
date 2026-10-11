import { COMPANY, PRODUCT, SUPPORT_EMAIL } from '../brand';
import { MarkIcon } from './Icons';

interface Props {
  /** The vendor, once the platform has reported it. */
  vendor?: string;
  /** Abandon this application and start a fresh one. */
  onNewApplication: () => void;
}

export function AppHeader({ vendor, onNewApplication }: Props) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <MarkIcon />
        </span>
        <span className="brand-name">{COMPANY}</span>
        <span className="brand-rule" aria-hidden="true" />
        <span className="brand-product">{PRODUCT}</span>
      </div>

      <div className="topbar-right">
        <a href={`mailto:${SUPPORT_EMAIL}`} className="link">
          Partner support
        </a>
        {/* The vendor is a label, not an account: there is no sign-in here, so
            an avatar would promise something the product does not have. */}
        {vendor ? <span className="account-name">{vendor}</span> : null}
        <button type="button" className="btn btn--quiet btn--sm" onClick={onNewApplication}>
          New application
        </button>
      </div>
    </header>
  );
}
