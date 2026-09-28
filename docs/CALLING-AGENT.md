# Configure and test Faultline calling and SMS

Faultline directly notifies the active onsite engineers assigned to the cluster that produced an incident. There are no escalation policies, ordered steps, or delayed recipients.

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

Configure the Retell status webhook:

```text
POST https://<public-notification-host>/webhooks/retell
```

Both endpoints require a valid `x-retell-signature`. For local development, expose notification port `3004` through an HTTPS tunnel.

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

Acknowledging one call records incident ownership and changes the durable notification state to `ACKNOWLEDGED`. A decline is recorded but starts no additional calls because every assigned engineer was already contacted in the initial dispatch.

## Configure a recipient

Create an onsite engineer through the Admin user API or UI. Assign them under **Clusters → Assigned SREs**, then create the linked notification contact:

```powershell
$headers = @{ Authorization = 'Bearer <admin-access-token>' }

$contact = Invoke-RestMethod http://localhost:3000/contacts `
  -Method Post `
  -Headers $headers `
  -ContentType 'application/json' `
  -Body (@{
    organizationId = 'default'
    userId = '<onsite-engineer-user-id>'
    name = 'Payments SRE'
    role = 'ENGINEER'
    phoneNumber = '+15551234567'
    voiceEnabled = $true
    smsEnabled = $true
    enabled = $true
  } | ConvertTo-Json)
```

If an organization has no assigned, contactable onsite engineer, link a notification contact to its primary Admin account so fallback delivery can succeed.

## Runtime behavior

- Critical incidents notify immediately.
- High incidents notify only when `NOTIFICATION_HIGH_SEVERITY_ENABLED=true`.
- Every resolved engineer is contacted in the same dispatch pass.
- Voice and SMS are both used when both contact flags are enabled.
- Duplicate incident lifecycle events do not create duplicate attempts.
- Provider failures are stored on the notification attempt but do not trigger delayed steps or retries.
- Provider callbacks remain idempotent and update the original attempt.
- Incident resolution closes the durable notification state.
- Notification attempts, acknowledgements, and audit events are retained independently from the removed policy tables.

## Database migration

Apply migrations `0014_direct_cluster_notifications` and `0016_cluster_sre_assignments` before deploying the new worker:

```powershell
npm run db:migrate
```

It:

- Adds `notification_contacts.user_id`.
- Adds `incident_notification_states`.
- Converts existing execution state where the incident and cluster still exist.
- Removes `escalation_executions` and `escalation_policies`.
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
