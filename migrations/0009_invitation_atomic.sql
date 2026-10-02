ALTER TABLE project_invites ADD COLUMN consumed_by TEXT REFERENCES users(id);
CREATE TRIGGER invite_join AFTER UPDATE OF consumed_at ON project_invites WHEN NEW.consumed_at IS NOT NULL BEGIN
 INSERT INTO project_members(id,project_id,user_id,role,status,created_at) VALUES(lower(hex(randomblob(16))),NEW.project_id,NEW.consumed_by,NEW.role,'ACTIVE',NEW.consumed_at);
 INSERT INTO audit_events(project_id,actor_user_id,event_type,target_type,target_id,created_at) VALUES(NEW.project_id,NEW.consumed_by,'MEMBER_JOINED','invite',NEW.id,NEW.consumed_at);
END;
