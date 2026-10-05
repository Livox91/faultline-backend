import { BadRequestException } from '@nestjs/common';
import { normalizePhoneNumber, type Contact } from '@faultline/notifications';

/**
 * What an onsite engineer's notification contact must hold for Retell to call them.
 *
 * The incident dispatcher resolves each assigned engineer to their linked contact and
 * skips anyone whose contact is disabled, has voice off or an unusable number (see
 * `ClusterRecipientResolver`). These rules refuse such a contact when it is saved,
 * rather than leaving it to be discovered when an incident call never goes out.
 */
export const ENGINEER_CONTACT_RULE =
  'An onsite engineer needs an enabled contact with a valid E.164 phone number and voice calls on, so Retell can call them';

const ENGINEERING_ROLES: readonly Contact['role'][] = [
  'ENGINEER',
  'SENIOR_ENGINEER',
  'TEAM_LEAD',
  'MANAGER',
];

/** The number normalized to E.164, or a 400 that says what is wrong with it. */
export function e164(value: unknown, field = 'phoneNumber'): string {
  if (typeof value !== 'string' || !value.trim())
    throw new BadRequestException(`${field} is required`);
  try {
    return normalizePhoneNumber(value);
  } catch (error) {
    throw new BadRequestException((error as Error).message);
  }
}

/** Whether Retell can place a voice call to this contact. */
export function isCallable(
  contact: Pick<Contact, 'role' | 'enabled' | 'voiceEnabled' | 'phoneNumber'>,
): boolean {
  if (!ENGINEERING_ROLES.includes(contact.role)) return false;
  if (!contact.enabled || !contact.voiceEnabled) return false;
  try {
    normalizePhoneNumber(contact.phoneNumber);
    return true;
  } catch {
    return false;
  }
}
