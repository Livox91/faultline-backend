-- migrate:up
ALTER TABLE incident_communications
  ADD COLUMN provider_request_id text,
  ADD COLUMN status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'SUPPRESSED'));

UPDATE incident_communications
   SET provider_request_id=aggregate->>'providerRequestId',
       status=CASE
         WHEN aggregate->>'status' IN ('PENDING', 'SENT', 'FAILED', 'SUPPRESSED')
           THEN aggregate->>'status'
         ELSE 'PENDING'
       END;

CREATE INDEX incident_communications_provider_request_idx
  ON incident_communications (provider_request_id)
  WHERE provider_request_id IS NOT NULL;

-- migrate:down
DROP INDEX incident_communications_provider_request_idx;
ALTER TABLE incident_communications
  DROP COLUMN status,
  DROP COLUMN provider_request_id;
