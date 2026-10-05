import { Inject, Injectable } from '@nestjs/common';
import {
  ROLES,
  USER_REPOSITORY,
  type UserRecord,
  type UserRepository,
} from '@faultline/auth';
import {
  CONTACT_REPOSITORY,
  CLUSTER_SRE_ASSIGNMENT_REPOSITORY,
  contactAudience,
  normalizePhoneNumber,
  type Contact,
  type ContactRepository,
  type ClusterSreAssignmentRepository,
  type NotificationChannel,
  type NotificationRecipient,
} from '@faultline/notifications';

export interface DirectRecipient {
  recipient: NotificationRecipient;
  channels: readonly NotificationChannel[];
  source: 'ASSIGNED_SRE' | 'ADMIN_FALLBACK';
}

export interface DirectRecipientResolution {
  recipients: readonly DirectRecipient[];
  skipped: readonly { referenceId: string; reason: string }[];
  fallbackUsed: boolean;
}

@Injectable()
export class ClusterRecipientResolver {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(CLUSTER_SRE_ASSIGNMENT_REPOSITORY)
    private readonly assignments: ClusterSreAssignmentRepository,
    @Inject(CONTACT_REPOSITORY) private readonly contacts: ContactRepository,
  ) {}

  async resolve(
    clusterId: string,
    organizationId: string,
  ): Promise<DirectRecipientResolution> {
    const assignedIds = (await this.assignments.listForCluster(clusterId)).map(
      (assignment) => assignment.userId,
    );
    const assignedUsers = await Promise.all(
      assignedIds.map((id) => this.users.findById(id)),
    );
    const engineers = assignedUsers.filter(
      (user): user is UserRecord =>
        !!user &&
        user.organizationId === organizationId &&
        user.status === 'active' &&
        user.role === ROLES.ONSITE_ENGINEER,
    );
    const engineerResult = await this.resolveUsers(
      engineers,
      organizationId,
      'ASSIGNED_SRE',
    );
    if (engineerResult.recipients.length)
      return { ...engineerResult, fallbackUsed: false };

    const adminResult = await this.resolveAdmin(organizationId);
    return {
      recipients: adminResult.recipients,
      skipped: [...engineerResult.skipped, ...adminResult.skipped],
      fallbackUsed: true,
    };
  }

  async resolveAdmin(
    organizationId: string,
  ): Promise<Omit<DirectRecipientResolution, 'fallbackUsed'>> {
    const admins = (await this.users.list())
      .filter(
        (user) =>
          user.organizationId === organizationId &&
          user.status === 'active' &&
          user.role === ROLES.ADMIN,
      )
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      );
    return this.resolveUsers(
      admins.slice(0, 1),
      organizationId,
      'ADMIN_FALLBACK',
    );
  }

  async resolveAdminUser(
    userId: string,
    organizationId: string,
  ): Promise<Omit<DirectRecipientResolution, 'fallbackUsed'>> {
    const user = await this.users.findById(userId);
    if (!user || user.organizationId !== organizationId || user.status !== 'active' || user.role !== ROLES.ADMIN)
      return { recipients: [], skipped: [{ referenceId: userId, reason: 'ADMIN_NOT_AVAILABLE' }] };
    return this.resolveUsers([user], organizationId, 'ADMIN_FALLBACK');
  }

  private async resolveUsers(
    users: readonly UserRecord[],
    organizationId: string,
    source: DirectRecipient['source'],
  ): Promise<Omit<DirectRecipientResolution, 'fallbackUsed'>> {
    const contacts = await this.contacts.findByUserIds(
      users.map((user) => user.id),
      organizationId,
    );
    const byUser = new Map(
      contacts.flatMap((contact) =>
        contact.userId ? [[contact.userId, contact] as const] : [],
      ),
    );
    const recipients: DirectRecipient[] = [];
    const skipped: { referenceId: string; reason: string }[] = [];
    for (const user of users) {
      const contact = byUser.get(user.id);
      if (!contact) {
        skipped.push({ referenceId: user.id, reason: 'CONTACT_NOT_LINKED' });
        continue;
      }
      const resolved = this.contact(contact, source);
      if ('reason' in resolved) skipped.push(resolved);
      else recipients.push(resolved);
    }
    return { recipients, skipped };
  }

  private contact(
    contact: Contact,
    source: DirectRecipient['source'],
  ): DirectRecipient | { referenceId: string; reason: string } {
    if (!['ENGINEER', 'SENIOR_ENGINEER', 'TEAM_LEAD', 'MANAGER'].includes(contact.role))
      return { referenceId: contact.id, reason: 'NON_ENGINEERING_CONTACT' };
    if (!contact.enabled)
      return { referenceId: contact.id, reason: 'CONTACT_DISABLED' };
    let phoneNumber: string;
    try {
      phoneNumber = normalizePhoneNumber(contact.phoneNumber);
    } catch {
      return { referenceId: contact.id, reason: 'INVALID_PHONE_NUMBER' };
    }
    const channels: NotificationChannel[] = [];
    if (contact.voiceEnabled) channels.push('VOICE');
    if (contact.smsEnabled) channels.push('SMS');
    if (!channels.length)
      return { referenceId: contact.id, reason: 'CHANNEL_DISABLED' };
    return {
      source,
      channels,
      recipient: {
        id: contact.id,
        name: contact.name,
        phoneNumber,
        audience: contactAudience(contact.role),
      },
    };
  }
}
