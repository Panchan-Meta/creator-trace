-- Append diagnostic fields; keep all existing verification attempts immutable.
ALTER TABLE bitcoin_verification_attempts ADD COLUMN failure_stage TEXT;
ALTER TABLE bitcoin_verification_attempts ADD COLUMN error_type TEXT;
ALTER TABLE bitcoin_verification_attempts ADD COLUMN http_status INTEGER;
