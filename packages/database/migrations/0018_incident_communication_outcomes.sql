-- migrate:up
ALTER TABLE incident_communications
  DROP CONSTRAINT IF EXISTS incident_communications_status_check;

ALTER TABLE incident_communications
  ADD CONSTRAINT incident_communications_status_check
  CHECK (status IN (
    'PENDING', 'SENT', 'IN_PROGRESS', 'DELIVERED', 'ANSWERED',
    'ACKNOWLEDGED', 'DECLINED', 'COMPLETED', 'FAILED',
    'NO_ANSWER', 'CANCELLED', 'SUPPRESSED'
  ));

-- migrate:down
UPDATE incident_communications
   SET status=CASE
     WHEN status IN ('PENDING', 'SENT', 'FAILED', 'SUPPRESSED') THEN status
     WHEN status IN ('NO_ANSWER', 'CANCELLED', 'DECLINED') THEN 'FAILED'
     ELSE 'SENT'
   END;

ALTER TABLE incident_communications
  DROP CONSTRAINT IF EXISTS incident_communications_status_check;

ALTER TABLE incident_communications
  ADD CONSTRAINT incident_communications_status_check
  CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'SUPPRESSED'));
