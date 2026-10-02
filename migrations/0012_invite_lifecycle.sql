ALTER TABLE project_invites ADD COLUMN revoked_at TEXT;
DROP TRIGGER invite_join;
CREATE TRIGGER invite_accept_guard BEFORE UPDATE OF consumed_at ON project_invites
WHEN NEW.consumed_at IS NOT NULL AND (
 OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL OR OLD.expires_at<=NEW.consumed_at
 OR NEW.consumed_by IS NULL
 OR EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND archived_at IS NOT NULL)
 OR EXISTS(SELECT 1 FROM project_members WHERE project_id=NEW.project_id AND user_id=NEW.consumed_by AND status='ACTIVE'))
BEGIN SELECT RAISE(ABORT,'invite cannot be accepted'); END;
CREATE TRIGGER invite_join AFTER UPDATE OF consumed_at ON project_invites WHEN NEW.consumed_at IS NOT NULL BEGIN
 INSERT INTO project_members(id,project_id,user_id,role,status,created_at) VALUES(lower(hex(randomblob(16))),NEW.project_id,NEW.consumed_by,NEW.role,'ACTIVE',NEW.consumed_at)
 ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role,status='ACTIVE',created_at=excluded.created_at;
 INSERT INTO audit_events(project_id,actor_user_id,event_type,target_type,target_id,created_at) VALUES(NEW.project_id,NEW.consumed_by,'MEMBER_JOINED','invite',NEW.id,NEW.consumed_at);
END;
