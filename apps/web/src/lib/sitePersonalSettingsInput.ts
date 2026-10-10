import type {
  ComputeTargetDetails,
  SitePersonalSettings,
  SitePersonalSettingsInput,
} from '@mmt/contracts';
import type { FormValues } from '../types/form';
import { getFieldValue } from './formValues';
import { parseAccountName, parseSiteDirectory } from './siteSettingsInput';
import { formatSiteVariables, parseSiteVariables } from './siteVariables';
import { text } from '../i18n/catalog';

/**
 * What a person sets for themselves on a site. Where the launcher logs in as each requester
 * ('withAccount'), they name their account, which the launcher makes a key for. On a manual site
 * ('withoutAccount') whoever runs `mado-tracking submit` submits as themselves, so only the work
 * directory and variables remain. A shared account ('none') runs everyone's Jobs alike, and the
 * API refuses personal settings there (site_settings_invalid).
 */
export type PersonalSettingsScope = 'withAccount' | 'withoutAccount' | 'none';

export function personalSettingsScope(
  target: Pick<ComputeTargetDetails, 'submissionMode' | 'siteAccountMode'>,
): PersonalSettingsScope {
  if (target.submissionMode === 'manual') return 'withoutAccount';
  return target.siteAccountMode === 'personal' ? 'withAccount' : 'none';
}

export function personalSettingsFormValues(item: SitePersonalSettings | null): FormValues {
  return {
    accountName: item?.accountName ?? '',
    personalWorkDirectory: item?.workDirectory ?? '',
    personalVariables: formatSiteVariables(item?.variables ?? {}),
  };
}

/**
 * One's settings as PUT .../personal-settings/me takes them. The account name is sent only where
 * the launcher logs in as each person, and is required there. An empty work directory falls back
 * to the site's.
 */
export function buildPersonalSettingsInput(
  values: FormValues,
  scope: Exclude<PersonalSettingsScope, 'none'>,
): SitePersonalSettingsInput {
  return {
    ...(scope === 'withAccount' && {
      accountName: parseAccountName(getFieldValue(values, 'accountName'), text.siteAccountNameRequired),
    }),
    workDirectory: parseSiteDirectory(getFieldValue(values, 'personalWorkDirectory')) || null,
    variables: parseSiteVariables(getFieldValue(values, 'personalVariables')),
  };
}
