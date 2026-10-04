# Configure and test Faultline calling and SMS

Faultline directly notifies the active onsite engineers assigned to the cluster that produced an incident. There are no escalation policies, ordered steps, or delayed recipients.

Outbound voice delivery uses the official Retell SDK's `client.call.createPhoneCall` operation. Faultline persists a `PENDING` incident communication with the returned Retell `call_id` before webhook or polling updates mark the communication sent or failed.

## Recipient selection

For a notifiable incident, Faultline:

1. Reads `incident.clusterId`.
2. Finds active `onsiteengineer` users in `cluster_sre_assignments` for that cluster.
3. Resolves each user to an enabled notification contact through `notification_contacts.user_id`.
4. Immediately uses every channel enabled on each resolved contact.
5. If no assigned SRE has a contactable notification contact, selects the oldest active Admin account in the organization as the primary Admin/Head Engineer fallback.

A Faultline login and a notification contact are separate records. Link them by setting the contact's `userId` to the user's ID. `project_users` controls cluster access, `cluster_sre_assignments` controls incident-call responsibility, and the contact controls the phone number and enabled channels.

## Retell configuration

Create or select:

- A Retell voice agent.
- A Retell phone number that supports outbound calls.
- An SMS/chat agent when SMS is enabled.

Set `apps/notification/.env`:

```dotenv
RETELL_API_KEY=
RETELL_FROM_NUMBER=
RETELL_VOICE_AGENT_ID=
RETELL_SMS_AGENT_ID=
NOTIFICATION_ORGANIZATION_ID=default
NOTIFICATION_HIGH_SEVERITY_ENABLED=false
```

The API key, from number, and voice-agent ID must be configured together. Phone numbers use E.164 format, such as `+15551234567`. The SMS agent ID is required before an SMS-enabled contact can be delivered successfully.

Configure the voice agent's signed action endpoint:

```text
POST https://<public-notification-host>/v1/voice/actions
```

The JSON body is:

```json
{
  "incidentId": "<incident_id>",
  "notificationAttemptId": "<notification_attempt_id>",
  "recipientId": "<recipient_id>",
  "action": "ACKNOWLEDGE_INCIDENT",
  "providerCallId": "<current Retell call id>",
  "timestamp": "<current ISO-8601 timestamp>"
}
```

`action` is `ACKNOWLEDGE_INCIDENT`, `DECLINE_INCIDENT`, or `UNKNOWN`.

Configure the Retell event webhook:

```text
POST https://<public-notification-host>/webhooks/retell
```

Both endpoints require a valid `x-retell-signature`. The event webhook accepts status events, explicit `ACKNOWLEDGE_INCIDENT` / `DECLINE_INCIDENT` tool results, and conservative end-of-call transcript decisions. For local development, expose notification port `3004` through an HTTPS tunnel.

## Voice-agent prompt

Faultline supplies deterministic dynamic variables, including `voice_script`, `notification_message`, `incident_id`, `notification_attempt_id`, `recipient_id`, `severity`, `affected_service`, `cluster`, `environment`, and `status`.

A minimal instruction is:

```text
You are the Faultline incident calling agent.
Read {{voice_script}} accurately and concisely.
Do not invent a cause, ETA, resolution, or technical detail.
Ask the acknowledgement question once.
If the engineer clearly accepts ownership, submit ACKNOWLEDGE_INCIDENT.
If the engineer clearly declines, submit DECLINE_INCIDENT.
If the answer is unclear, submit UNKNOWN and ask for clarification.
Never modify incident state yourself; Faultline is the source of truth.
```

Acknowledging one call records incident ownership and changes the durable notification state to `ACKNOWLEDGED`. This is intentionally separate from the operational incident status (`OPEN`, `ACTIVE`, or `RESOLVED`). A decline is recorded and immediately starts the one-time primary Admin fallback.

## Configure a recipient

An onsite engineer cannot exist without a phone number Retell can call. Creating one through **Team & Roles**, `POST /admin/users` or `npm run user:create` requires an E.164 `phoneNumber`, and creates the linked notification contact in the same step with voice on (SMS is optional and defaults to on):

```powershell
$headers = @{ Authorization = 'Bearer <admin-access-token>' }

$engineer = Invoke-RestMethod http://localhost:3000/admin/users `
  -Method Post `
  -Headers $headers `
  -ContentType 'application/json' `
  -Body (@{
    email = 'payments-sre@example.com'
    name = 'Payments SRE'
    role = 'onsiteengineer'
    password = '<at least 12 characters>'
    phoneNumber = '+15551234567'
    smsEnabled = $true
    projectIds = @('<cluster-id>')
  } | ConvertTo-Json)
```

The API keeps that contact callable. It refuses:

- an onsite engineer without a `phoneNumber`, with one that is not valid E.164, or with `voiceEnabled = $false`;
- a `/contacts` change that turns voice off or disables a contact linked to an onsite engineer;
- changing a user's role to `onsiteengineer` before they have a callable linked contact.

Then assign the engineer as an SRE of their clusters so incidents on those clusters call them.

If an organization has no assigned, contactable onsite engineer, link a notification contact to its primary Admin account so fallback delivery can succeed.

## Runtime behavior

- Critical incidents notify immediately.
- High incidents notify only when `NOTIFICATION_HIGH_SEVERITY_ENABLED=true`.
- Every resolved engineer is contacted in the same dispatch pass.
- Voice and SMS are both used when both contact flags are enabled.
- Duplicate incident lifecycle events do not create duplicate attempts.
- A failed, timed-out, unanswered, cancelled, or declined SRE voice call immediately triggers the primary Admin fallback once; there are no delayed escalation steps.
- Provider callbacks remain idempotent and update both the original attempt and its `incident_communications` record.
- Acknowledgement stops new alerting and atomically persists the acknowledgement, notification state, attempt, communication outcome, and audit entries.
- Incident resolution closes the durable notification state.
- Notification attempts, acknowledgements, and audit events are retained independently from the removed policy tables.

## Database migration

Apply migrations through `0018_incident_communication_outcomes` before deploying the new worker:

```powershell
npm run db:migrate
```

It:

- Adds `notification_contacts.user_id`.
- Adds `incident_notification_states`.
- Converts existing execution state where the incident and cluster still exist.
- Removes `escalation_executions` and `escalation_policies`.
- Adds provider request IDs and detailed Retell outcomes to `incident_communications`.
- Leaves notification attempts, acknowledgements, communications, idempotency records, and notification audit events intact.

The migration removes the deprecated policy definitions. Back up a production database before applying it if those definitions must be retained for external archival purposes.

## Verification

```powershell
npm run build
node --test tests/notifications.test.cjs
npm test
```

Before a real call:

1. Verify the notification service readiness endpoint.
2. Assign one test onsite engineer to the test cluster.
3. Link a contact with a phone number you control.
4. Enable only the channel being tested.
5. Verify both Retell callback URLs.
6. Generate a critical incident through the normal detection path.
7. Inspect:

```powershell
Invoke-RestMethod http://localhost:3000/incidents/<incident-id>/notification-state -Headers $headers
Invoke-RestMethod http://localhost:3000/incidents/<incident-id>/notification-attempts -Headers $headers
```

Do not run automated tests with production Retell credentials.
