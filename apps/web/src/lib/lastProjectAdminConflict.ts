import { RequestError } from '../api/http';
import { text } from '../i18n/catalog';

/**
 * Member and group binding changes answer 409 only when they would leave the Project without
 * an administrator, so the conflict is shown as that reason instead of the raw server text.
 */
export async function explainLastProjectAdminConflict<T>(change: Promise<T>): Promise<T> {
  try {
    return await change;
  } catch (failure) {
    if (failure instanceof RequestError && failure.status === 409)
      throw new Error(text.lastProjectAdminConflict);
    throw failure;
  }
}
