import { useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import { Menu, X } from 'lucide-react';
import { text } from '../i18n/catalog';
import type { NavigationGroup } from './navigationLinks';
import { NavigationLinkList } from './NavigationLinkList';
import { ProductLogo } from '../components/ProductLogo';

/**
 * The main navigation on narrow screens: a menu button that opens the grouped links in a drawer
 * from the left. The drawer is a modal <dialog>, so Esc closes it and focus returns to the button;
 * a tap outside it or on a link closes it too.
 */
export function NavigationDrawer({ groups }: { groups: NavigationGroup[] }) {
  const drawerId = useId();
  const drawerRef = useRef<HTMLDialogElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  useEffect(() => {
    const drawer = drawerRef.current;
    if (!drawer) return;
    if (isOpen && !drawer.open) drawer.showModal();
    if (!isOpen && drawer.open) drawer.close();
  }, [isOpen]);
  const closeOnBackdropOrLink = (event: MouseEvent<HTMLDialogElement>) => {
    // The panel inside fills the dialog box, so a click that targets the dialog itself landed on
    // the backdrop around it.
    const isBackdrop = event.target === event.currentTarget;
    if (isBackdrop || (event.target as Element).closest('a')) setIsOpen(false);
  };
  return (
    <>
      <button
        type="button"
        className="icon-button navigation-toggle"
        aria-label={isOpen ? text.closeNavigation : text.openNavigation}
        aria-expanded={isOpen}
        aria-controls={drawerId}
        onClick={() => setIsOpen((current) => !current)}
      >
        <Menu size={20} />
      </button>
      <dialog
        ref={drawerRef}
        id={drawerId}
        className="navigation-drawer"
        aria-label={text.navigation}
        onCancel={(event) => {
          event.preventDefault();
          setIsOpen(false);
        }}
        onClose={() => setIsOpen(false)}
        onClick={closeOnBackdropOrLink}
      >
        <div className="navigation-drawer-panel">
          <div className="navigation-drawer-header">
            <ProductLogo />
            <button
              type="button"
              className="icon-button"
              aria-label={text.closeNavigation}
              onClick={() => setIsOpen(false)}
            >
              <X size={20} />
            </button>
          </div>
          <NavigationLinkList groups={groups} />
        </div>
      </dialog>
    </>
  );
}
