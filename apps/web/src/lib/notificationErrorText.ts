import {
  notificationErrorLabels,
  notificationsTextTemplates,
} from '../i18n/notifications';

// Codes that carry a number from the destination (HTTP status or SMTP reply code).
const HTTP_STATUS_CODE = /^notification_http_(\d{3})$/;
const SMTP_REPLY_CODE = /^notification_smtp_(\d{3})$/;
// `<kind>_sender_unavailable`: the API server has no sender for the channel kind.
const SENDER_UNAVAILABLE_CODE = /_sender_unavailable$/;

/**
 * The reason a notification was not delivered, as shown in the test result and the delivery
 * history. The API stores only safe failure codes; an unknown code is kept so it can be reported.
 */
export function describeNotificationError(code: string): string {
  const known = notificationErrorLabels[code];
  if (known) return known;
  const httpStatus = HTTP_STATUS_CODE.exec(code)?.[1];
  if (httpStatus) return notificationsTextTemplates.notificationErrorHttp(httpStatus);
  const smtpReply = SMTP_REPLY_CODE.exec(code)?.[1];
  if (smtpReply) return notificationsTextTemplates.notificationErrorSmtp(smtpReply);
  if (SENDER_UNAVAILABLE_CODE.test(code)) return notificationErrorLabels.sender_unavailable!;
  return notificationsTextTemplates.notificationErrorUnknown(code);
}
