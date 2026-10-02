-- Additive migration: preserve all Creator Trace rows.
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN consent_at TEXT;
CREATE UNIQUE INDEX users_email ON users(email) WHERE email IS NOT NULL;
CREATE TABLE issuers (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE courses (id TEXT PRIMARY KEY, issuer_id TEXT NOT NULL REFERENCES issuers(id), name TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(issuer_id,name));
CREATE TABLE issuance_batches (
 id TEXT PRIMARY KEY, issuer_id TEXT NOT NULL REFERENCES issuers(id), source_filename TEXT NOT NULL, source_hash TEXT NOT NULL UNIQUE,
 row_count INTEGER NOT NULL DEFAULT 0, valid_count INTEGER NOT NULL DEFAULT 0, invalid_count INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL CHECK(status IN ('UPLOADED','VALIDATING','READY_FOR_APPROVAL','APPROVED','ISSUING','COMPLETED','FAILED','REJECTED')),
 created_at TEXT NOT NULL, approved_at TEXT, approved_by TEXT, completed_at TEXT, compliance_json TEXT
);
CREATE TABLE issuance_rows (
 id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES issuance_batches(id), row_number INTEGER NOT NULL,
 name TEXT NOT NULL, email TEXT NOT NULL, course TEXT NOT NULL, completed_at TEXT NOT NULL, errors_json TEXT NOT NULL DEFAULT '[]',
 UNIQUE(batch_id,row_number)
);
ALTER TABLE certificates ADD COLUMN certificate_id TEXT;
ALTER TABLE certificates ADD COLUMN issuer_id TEXT REFERENCES issuers(id);
ALTER TABLE certificates ADD COLUMN course_id TEXT REFERENCES courses(id);
ALTER TABLE certificates ADD COLUMN recipient_id TEXT REFERENCES users(id);
ALTER TABLE certificates ADD COLUMN batch_id TEXT REFERENCES issuance_batches(id);
ALTER TABLE certificates ADD COLUMN completed_at TEXT;
ALTER TABLE certificates ADD COLUMN issued_at TEXT;
ALTER TABLE certificates ADD COLUMN status TEXT CHECK(status IN ('PENDING','ACTIVE','REVOKED'));
ALTER TABLE certificates ADD COLUMN document_hash TEXT;
ALTER TABLE certificates ADD COLUMN updated_at TEXT;
ALTER TABLE certificates ADD COLUMN revoked_at TEXT;
ALTER TABLE certificates ADD COLUMN revocation_reason TEXT;
CREATE UNIQUE INDEX certificates_public_id ON certificates(certificate_id) WHERE certificate_id IS NOT NULL;
CREATE UNIQUE INDEX certificates_recipient_course ON certificates(recipient_id,course_id) WHERE recipient_id IS NOT NULL;
CREATE INDEX certificates_recipient ON certificates(recipient_id);
CREATE INDEX certificates_issuer ON certificates(issuer_id);
CREATE INDEX certificates_course ON certificates(course_id);
CREATE INDEX certificates_status ON certificates(status);
CREATE INDEX certificates_created ON certificates(created_at);
-- timestamp_proofs is reused as an append-only versioned proof ledger.
ALTER TABLE timestamp_proofs ADD COLUMN payload_json TEXT;
ALTER TABLE timestamp_proofs ADD COLUMN payload_hash TEXT;
ALTER TABLE timestamp_proofs ADD COLUMN certificate_status TEXT;
ALTER TABLE timestamp_proofs ADD COLUMN error_code TEXT;
CREATE INDEX proofs_certificate ON timestamp_proofs(certificate_id,created_at);
CREATE TABLE audit_logs (id TEXT PRIMARY KEY, actor_type TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE INDEX audit_target ON audit_logs(target_type,target_id,created_at);
CREATE INDEX audit_created ON audit_logs(created_at);
CREATE TABLE notifications (id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL REFERENCES users(id), notification_type TEXT NOT NULL, certificate_id TEXT NOT NULL REFERENCES certificates(id), verify_url TEXT NOT NULL, registration_url TEXT, status TEXT NOT NULL CHECK(status IN ('PENDING','SENT','FAILED')), created_at TEXT NOT NULL, sent_at TEXT);
CREATE INDEX notifications_status ON notifications(status,created_at);
CREATE TABLE enrollment_tokens (token_hash TEXT PRIMARY KEY, recipient_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL, consumed_at TEXT);
CREATE TABLE webauthn_credentials (id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL REFERENCES users(id), public_key TEXT NOT NULL, counter INTEGER NOT NULL, transports_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX credentials_recipient ON webauthn_credentials(recipient_id);
CREATE TABLE auth_challenges (id TEXT PRIMARY KEY, challenge TEXT NOT NULL, kind TEXT NOT NULL, recipient_id TEXT REFERENCES users(id), enrollment_hash TEXT, expires_at TEXT NOT NULL);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, recipient_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL);
CREATE INDEX sessions_recipient ON sessions(recipient_id);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
CREATE INDEX batches_status ON issuance_batches(status,created_at);
CREATE INDEX rows_batch ON issuance_rows(batch_id);
-- Human authorization and terminal-state rules are also enforced below the service layer.
CREATE TRIGGER certificate_requires_approval BEFORE INSERT ON certificates WHEN NEW.certificate_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM issuance_batches WHERE id=NEW.batch_id AND approved_by='Punka' AND status='ISSUING') BEGIN SELECT RAISE(ABORT,'Punka approval required'); END;
CREATE TRIGGER certificate_no_delete BEFORE DELETE ON certificates BEGIN SELECT RAISE(ABORT,'certificate history is permanent'); END;
CREATE TRIGGER certificate_revoked_terminal BEFORE UPDATE OF status ON certificates WHEN OLD.status='REVOKED' AND NEW.status!='REVOKED' BEGIN SELECT RAISE(ABORT,'revocation is permanent'); END;
CREATE TRIGGER certificate_no_transfer BEFORE UPDATE OF recipient_id ON certificates WHEN OLD.recipient_id IS NOT NULL AND NEW.recipient_id IS NOT OLD.recipient_id BEGIN SELECT RAISE(ABORT,'non-transferable'); END;
CREATE TRIGGER proof_no_delete BEFORE DELETE ON timestamp_proofs BEGIN SELECT RAISE(ABORT,'proof history is permanent'); END;
CREATE TRIGGER proof_payload_immutable BEFORE UPDATE OF payload_json,payload_hash,certificate_status ON timestamp_proofs WHEN OLD.payload_hash IS NOT NULL BEGIN SELECT RAISE(ABORT,'proof payload is immutable'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT,'audit history is permanent'); END;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT,'audit history is immutable'); END;
ALTER TABLE certificates ADD COLUMN document_json TEXT;
ALTER TABLE webauthn_credentials ADD COLUMN enrollment_hash TEXT REFERENCES enrollment_tokens(token_hash);
CREATE TRIGGER credential_invitation_guard BEFORE INSERT ON webauthn_credentials WHEN NEW.enrollment_hash IS NULL OR NOT EXISTS(SELECT 1 FROM enrollment_tokens WHERE token_hash=NEW.enrollment_hash AND recipient_id=NEW.recipient_id AND consumed_at IS NULL AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'unused invitation required'); END;
CREATE UNIQUE INDEX proof_one_state ON timestamp_proofs(certificate_id,certificate_status) WHERE certificate_status IS NOT NULL;
CREATE TRIGGER certificate_document_immutable BEFORE UPDATE OF document_hash,document_json,certificate_id,issuer_id,course_id,completed_at,issued_at ON certificates WHEN OLD.certificate_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'certificate document is immutable'); END;

CREATE UNIQUE INDEX credentials_enrollment ON webauthn_credentials(enrollment_hash);
CREATE TRIGGER batch_approval_audit AFTER UPDATE OF status ON issuance_batches WHEN NEW.status='APPROVED' AND OLD.status!='APPROVED' BEGIN INSERT INTO audit_logs VALUES(lower(hex(randomblob(16))),'HUMAN','Punka','BATCH_APPROVED','batch',NEW.id,'{}',NEW.approved_at); END;
CREATE TRIGGER batch_rejection_audit AFTER UPDATE OF status ON issuance_batches WHEN NEW.status='REJECTED' AND OLD.status!='REJECTED' BEGIN INSERT INTO audit_logs VALUES(lower(hex(randomblob(16))),'HUMAN','Punka','BATCH_REJECTED','batch',NEW.id,'{}',strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
CREATE TRIGGER proof_status_audit AFTER UPDATE OF status ON timestamp_proofs WHEN NEW.status IN ('confirmed','failed') AND NEW.status!=OLD.status AND NEW.payload_hash IS NOT NULL BEGIN INSERT INTO audit_logs VALUES(lower(hex(randomblob(16))),'SYSTEM','proof-verifier',CASE NEW.status WHEN 'confirmed' THEN 'PROOF_CONFIRMED' ELSE 'PROOF_FAILED' END,'proof',NEW.id,'{}',strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
CREATE TRIGGER certificate_activation_audit AFTER UPDATE OF status ON certificates WHEN NEW.status='ACTIVE' AND OLD.status='PENDING' BEGIN INSERT INTO audit_logs VALUES(lower(hex(randomblob(16))),'SYSTEM','proof-verifier','CERTIFICATE_ACTIVATED','certificate',NEW.certificate_id,'{}',NEW.updated_at); END;
