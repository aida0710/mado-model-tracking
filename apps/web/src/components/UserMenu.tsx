import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { canChangeOwnPassword } from '../lib/permissions';
import { text } from '../i18n/catalog';

export const ACCOUNT_PATH = '/account';
export const ACCOUNT_PASSWORD_PATH = '/account/password';

// Two letters fit the 27px avatar circle.
const AVATAR_INITIALS_LENGTH = 2;

/** The avatar in the top bar; it opens a menu with the signed-in user and their account pages. */
export function UserMenu() {
  const auth = useAuth();
  const location = useLocation();
  const menuId = useId();
  const container = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const initials = auth.user.displayName.slice(0, AVATAR_INITIALS_LENGTH).toUpperCase();

  useEffect(() => setIsOpen(false), [location.pathname]);
  useEffect(() => {
    if (!isOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen]);

  return (
    <div className="user-menu" ref={container}>
      <button
        type="button"
        className="avatar"
        title={auth.user.displayName}
        aria-label={text.userMenu}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={menuId}
        onClick={() => setIsOpen((open) => !open)}
      >
        {initials}
      </button>
      {isOpen && (
        <div className="user-menu-popover" id={menuId} role="menu" aria-label={text.userMenu}>
          <div className="user-menu-identity">
            <strong>{auth.user.displayName}</strong>
            {auth.user.email && <span className="muted">{auth.user.email}</span>}
          </div>
          <Link role="menuitem" to={ACCOUNT_PATH}>
            {text.account}
          </Link>
          {canChangeOwnPassword(auth.user) && (
            <Link role="menuitem" to={ACCOUNT_PASSWORD_PATH}>
              {text.changePasswordTitle}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
