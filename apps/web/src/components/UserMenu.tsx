import { useId } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { usePopover } from '../hooks/usePopover';
import { userMenuLinks } from '../layout/userMenuLinks';
import { text } from '../i18n/catalog';

// Two letters fit the 27px avatar circle.
const AVATAR_INITIALS_LENGTH = 2;

/**
 * The avatar in the top bar; it opens a menu with the signed-in user, their account pages and
 * 全体設定.
 */
export function UserMenu() {
  const auth = useAuth();
  const menuId = useId();
  const { container, isOpen, toggle } = usePopover();
  const initials = auth.user.displayName.slice(0, AVATAR_INITIALS_LENGTH).toUpperCase();

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
        onClick={toggle}
      >
        {initials}
      </button>
      {isOpen && (
        <div className="user-menu-popover" id={menuId} role="menu" aria-label={text.userMenu}>
          <div className="user-menu-identity">
            <strong>{auth.user.displayName}</strong>
            {auth.user.email && <span className="muted">{auth.user.email}</span>}
          </div>
          {userMenuLinks(auth.user).map((link) => (
            <Link
              key={link.label}
              role="menuitem"
              to={link.to}
              className={link.isSettingsEntry ? 'user-menu-settings' : undefined}
            >
              {link.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
