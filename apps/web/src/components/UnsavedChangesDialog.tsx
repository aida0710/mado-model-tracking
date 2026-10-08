import { Dialog } from './Dialog';
import { text } from '../i18n/catalog';

export function UnsavedChangesDialog({ onDiscard, onKeepEditing }: {
  onDiscard: () => void; onKeepEditing: () => void;
}) {
  return (
    <Dialog title={text.unsavedChanges} onClose={onKeepEditing}>
      <p className="notice">{text.discardChangesHint}</p>
      <footer>
        <button type="button" className="button" onClick={onKeepEditing}>{text.keepEditing}</button>
        <button type="button" className="button danger" onClick={onDiscard}>{text.discardChanges}</button>
      </footer>
    </Dialog>
  );
}
