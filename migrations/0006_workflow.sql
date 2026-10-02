-- Immutable Phase1 versions remain intact; mutable state is separate.
CREATE TABLE asset_version_states (
 asset_version_id TEXT PRIMARY KEY REFERENCES asset_versions(id),
 status TEXT NOT NULL CHECK(status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','FINAL')),
 actor_user_id TEXT REFERENCES users(id), reason TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
);
CREATE TABLE asset_version_state_history (
 id INTEGER PRIMARY KEY AUTOINCREMENT, asset_version_id TEXT NOT NULL REFERENCES asset_versions(id),
 from_status TEXT, to_status TEXT NOT NULL, actor_user_id TEXT REFERENCES users(id), reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE audit_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT REFERENCES projects(id), actor_user_id TEXT REFERENCES users(id),
 event_type TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
INSERT INTO asset_version_states SELECT id,status,created_by,'Phase1 migration',created_at FROM asset_versions;
INSERT INTO asset_version_state_history(asset_version_id,to_status,actor_user_id,reason,created_at) SELECT id,status,created_by,'Phase1 migration',created_at FROM asset_versions;
CREATE TRIGGER version_state_created AFTER INSERT ON asset_versions BEGIN
 INSERT INTO asset_version_states VALUES(NEW.id,NEW.status,NEW.created_by,'',NEW.created_at);
 INSERT INTO asset_version_state_history(asset_version_id,to_status,actor_user_id,created_at) VALUES(NEW.id,NEW.status,NEW.created_by,NEW.created_at);
 INSERT INTO audit_events(project_id,actor_user_id,event_type,target_type,target_id,created_at) SELECT project_id,NEW.created_by,'VERSION_CREATED','asset_version',NEW.id,NEW.created_at FROM assets WHERE id=NEW.asset_id;
END;
CREATE TRIGGER state_transition_guard BEFORE UPDATE ON asset_version_states
WHEN NEW.asset_version_id!=OLD.asset_version_id OR NOT (
 (OLD.status='DRAFT' AND NEW.status='SUBMITTED') OR
 (OLD.status='SUBMITTED' AND NEW.status IN ('APPROVED','REJECTED')) OR
 (OLD.status='APPROVED' AND NEW.status='FINAL'))
BEGIN SELECT RAISE(ABORT,'invalid state transition'); END;
CREATE TRIGGER state_transition_history AFTER UPDATE ON asset_version_states BEGIN
 INSERT INTO asset_version_state_history(asset_version_id,from_status,to_status,actor_user_id,reason,created_at) VALUES(NEW.asset_version_id,OLD.status,NEW.status,NEW.actor_user_id,NEW.reason,NEW.updated_at);
 INSERT INTO audit_events(project_id,actor_user_id,event_type,target_type,target_id,created_at) SELECT a.project_id,NEW.actor_user_id,'VERSION_'||CASE NEW.status WHEN 'FINAL' THEN 'FINALIZED' ELSE NEW.status END,'asset_version',NEW.asset_version_id,NEW.updated_at FROM assets a JOIN asset_versions v ON v.asset_id=a.id WHERE v.id=NEW.asset_version_id;
 INSERT INTO approvals(id,asset_version_id,approver_id,status,comment,created_at) SELECT lower(hex(randomblob(16))),NEW.asset_version_id,NEW.actor_user_id,NEW.status,NEW.reason,NEW.updated_at WHERE NEW.status IN ('APPROVED','REJECTED');
END;
CREATE TRIGGER state_no_delete BEFORE DELETE ON asset_version_states BEGIN SELECT RAISE(ABORT,'state is permanent'); END;
CREATE TRIGGER state_history_no_update BEFORE UPDATE ON asset_version_state_history BEGIN SELECT RAISE(ABORT,'history is immutable'); END;
CREATE TRIGGER state_history_no_delete BEFORE DELETE ON asset_version_state_history BEGIN SELECT RAISE(ABORT,'history is permanent'); END;
CREATE TRIGGER audit_event_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT,'audit is immutable'); END;
CREATE TRIGGER audit_event_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT,'audit is permanent'); END;
CREATE TRIGGER approval_no_update BEFORE UPDATE ON approvals BEGIN SELECT RAISE(ABORT,'approval is immutable'); END;
CREATE TRIGGER approval_no_delete BEFORE DELETE ON approvals BEGIN SELECT RAISE(ABORT,'approval is permanent'); END;
