-- Copy every existing membership and retain its id. Historical production tables stay intact.
DROP TRIGGER project_owner_member;
DROP TRIGGER invite_accept_guard;
DROP TRIGGER invite_join;
CREATE TABLE project_members_next(
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),user_id TEXT NOT NULL REFERENCES users(id),
 role TEXT NOT NULL CHECK(role IN ('OWNER','MANAGER','CREATOR','REVIEWER','VIEWER')),
 status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','REMOVED','REVOKED')),
 created_at TEXT NOT NULL,removed_at TEXT,removed_by TEXT REFERENCES users(id),UNIQUE(project_id,user_id)
);
INSERT INTO project_members_next(id,project_id,user_id,role,status,created_at) SELECT id,project_id,user_id,role,status,created_at FROM project_members;
DROP TABLE project_members;
ALTER TABLE project_members_next RENAME TO project_members;
CREATE INDEX members_user_status ON project_members(user_id,status,project_id);
CREATE TABLE project_member_history(
 id INTEGER PRIMARY KEY AUTOINCREMENT,member_id TEXT NOT NULL REFERENCES project_members(id),project_id TEXT NOT NULL REFERENCES projects(id),
 user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL,status TEXT NOT NULL,joined_at TEXT NOT NULL,
 removed_at TEXT,removed_by TEXT REFERENCES users(id),event_type TEXT NOT NULL,created_at TEXT NOT NULL
);
INSERT INTO project_member_history(member_id,project_id,user_id,role,status,joined_at,event_type,created_at)
 SELECT id,project_id,user_id,role,status,created_at,'MEMBER_IMPORTED',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM project_members;
CREATE TRIGGER membership_identity_guard BEFORE UPDATE ON project_members WHEN NEW.id!=OLD.id OR NEW.project_id!=OLD.project_id OR NEW.user_id!=OLD.user_id BEGIN SELECT RAISE(ABORT,'membership identity is immutable'); END;
CREATE TRIGGER membership_no_delete BEFORE DELETE ON project_members BEGIN SELECT RAISE(ABORT,'membership is permanent'); END;
CREATE TRIGGER membership_owner_guard BEFORE UPDATE ON project_members
 WHEN OLD.role='OWNER' AND (NEW.role!='OWNER' OR NEW.status!='ACTIVE') BEGIN SELECT RAISE(ABORT,'owner cannot be removed'); END;
CREATE TRIGGER membership_remove_guard BEFORE UPDATE ON project_members WHEN NEW.status='REMOVED' AND (
 OLD.status!='ACTIVE' OR NEW.removed_at IS NULL OR NEW.removed_by IS NULL OR
 NOT EXISTS(SELECT 1 FROM project_members WHERE project_id=NEW.project_id AND user_id=NEW.removed_by AND role='OWNER' AND status='ACTIVE'))
 BEGIN SELECT RAISE(ABORT,'active owner required'); END;
CREATE TRIGGER membership_history_insert AFTER INSERT ON project_members BEGIN
 INSERT INTO project_member_history(member_id,project_id,user_id,role,status,joined_at,event_type,created_at) VALUES(NEW.id,NEW.project_id,NEW.user_id,NEW.role,NEW.status,NEW.created_at,'MEMBER_JOINED',NEW.created_at);
END;
CREATE TRIGGER membership_history_update AFTER UPDATE ON project_members WHEN OLD.status!=NEW.status OR OLD.role!=NEW.role OR OLD.created_at!=NEW.created_at BEGIN
 INSERT INTO project_member_history(member_id,project_id,user_id,role,status,joined_at,removed_at,removed_by,event_type,created_at)
 VALUES(NEW.id,NEW.project_id,NEW.user_id,NEW.role,NEW.status,NEW.created_at,NEW.removed_at,NEW.removed_by,CASE WHEN NEW.status='ACTIVE' THEN 'MEMBER_REJOINED' ELSE 'MEMBER_REMOVED' END,COALESCE(NEW.removed_at,NEW.created_at));
END;
CREATE TRIGGER membership_history_no_update BEFORE UPDATE ON project_member_history BEGIN SELECT RAISE(ABORT,'membership history is immutable'); END;
CREATE TRIGGER membership_history_no_delete BEFORE DELETE ON project_member_history BEGIN SELECT RAISE(ABORT,'membership history is permanent'); END;
CREATE TRIGGER membership_removed_audit AFTER UPDATE ON project_members WHEN OLD.status='ACTIVE' AND NEW.status='REMOVED' BEGIN
 INSERT INTO audit_events(project_id,actor_user_id,event_type,target_type,target_id,metadata_json,created_at)
 VALUES(NEW.project_id,NEW.removed_by,'MEMBER_REMOVED','member',NEW.id,json_object('project_id',NEW.project_id,'member_user_id',NEW.user_id,'removed_by',NEW.removed_by,'role',NEW.role,'timestamp',NEW.removed_at),NEW.removed_at);
END;
CREATE TRIGGER project_owner_member AFTER INSERT ON projects BEGIN
 INSERT INTO project_members(id,project_id,user_id,role,status,created_at) VALUES(lower(hex(randomblob(16))),NEW.id,NEW.owner_id,'OWNER','ACTIVE',NEW.created_at);
 INSERT INTO audit_events(project_id,actor_user_id,event_type,target_type,target_id,created_at) VALUES(NEW.id,NEW.owner_id,'PROJECT_CREATED','project',NEW.id,NEW.created_at);
END;
CREATE TRIGGER invite_accept_guard BEFORE UPDATE OF consumed_at ON project_invites
WHEN NEW.consumed_at IS NOT NULL AND (
 OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL OR OLD.expires_at<=NEW.consumed_at OR NEW.consumed_by IS NULL
 OR EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND archived_at IS NOT NULL)
 OR EXISTS(SELECT 1 FROM project_members WHERE project_id=NEW.project_id AND user_id=NEW.consumed_by AND status='ACTIVE'))
BEGIN SELECT RAISE(ABORT,'invite cannot be accepted'); END;
CREATE TRIGGER invite_join AFTER UPDATE OF consumed_at ON project_invites WHEN NEW.consumed_at IS NOT NULL BEGIN
 INSERT INTO audit_events(project_id,actor_user_id,event_type,target_type,target_id,metadata_json,created_at)
 SELECT NEW.project_id,NEW.created_by,'MEMBER_REINVITED','invite',NEW.id,json_object('member_user_id',NEW.consumed_by,'role',NEW.role),NEW.consumed_at
 WHERE EXISTS(SELECT 1 FROM project_members WHERE project_id=NEW.project_id AND user_id=NEW.consumed_by AND status IN ('REMOVED','REVOKED'));
 INSERT INTO project_members(id,project_id,user_id,role,status,created_at) VALUES(lower(hex(randomblob(16))),NEW.project_id,NEW.consumed_by,NEW.role,'ACTIVE',NEW.consumed_at)
 ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role,status='ACTIVE',created_at=excluded.created_at,removed_at=NULL,removed_by=NULL;
 INSERT INTO audit_events(project_id,actor_user_id,event_type,target_type,target_id,created_at) VALUES(NEW.project_id,NEW.consumed_by,'MEMBER_JOINED','invite',NEW.id,NEW.consumed_at);
END;
