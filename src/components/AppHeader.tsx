import { COMPANY, PRODUCT, SUPPORT_EMAIL } from '../brand';
import { MarkIcon } from './Icons';

interface Props {
  /** The vendor, once the agent has reported it. */
  vendor?: string;
}

export function AppHeader({ vendor }: Props) {
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
        <span className="account">
          <span className="avatar" aria-hidden="true">
            {initials(vendor)}
          </span>
          <span className="account-name">{vendor ?? 'New application'}</span>
        </span>
      </div>
    </header>
  );
}

function initials(vendor?: string): string {
  if (!vendor) return '–';
  const words = vendor.split(/\s+/).filter(Boolean);
  return (words[0]?.[0] ?? '').concat(words[1]?.[0] ?? '').toUpperCase() || '–';
}
