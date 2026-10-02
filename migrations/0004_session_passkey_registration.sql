-- Additional passkeys use an authenticated session rather than an enrollment token.
-- The API binds both challenge creation and verification to the same recipient.
DROP TRIGGER credential_invitation_guard;
CREATE TRIGGER credential_invitation_guard BEFORE INSERT ON webauthn_credentials
WHEN NEW.enrollment_hash IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM enrollment_tokens WHERE token_hash=NEW.enrollment_hash
 AND recipient_id=NEW.recipient_id AND consumed_at IS NULL
 AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
)
BEGIN SELECT RAISE(ABORT,'unused invitation required'); END;
