/**
 * Who created a record (a Run, an automation rule), by the `createdByName` the API adds; the id
 * only while an older API omits the name.
 */
export const creatorName = (record: { createdBy: string; createdByName?: string | null }) =>
  record.createdByName || record.createdBy;
