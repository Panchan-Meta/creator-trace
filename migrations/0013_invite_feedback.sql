ALTER TABLE project_invites ADD COLUMN expired_at TEXT;
CREATE INDEX invites_pending_email ON project_invites(project_id,lower(trim(email)),expires_at) WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE TRIGGER invite_duplicate_guard BEFORE INSERT ON project_invites
WHEN EXISTS(SELECT 1 FROM project_invites WHERE project_id=NEW.project_id AND lower(trim(email))=lower(trim(NEW.email)) AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>NEW.created_at)
BEGIN SELECT RAISE(ABORT,'duplicate pending invitation'); END;
CREATE TRIGGER invite_expired_audit AFTER UPDATE OF expired_at ON project_invites
WHEN OLD.expired_at IS NULL AND NEW.expired_at IS NOT NULL
BEGIN
 INSERT INTO audit_events(project_id,event_type,target_type,target_id,created_at) VALUES(NEW.project_id,'INVITE_EXPIRED','invite',NEW.id,NEW.expired_at);
END;
