-- Add fields and counters without modifying existing assets, versions or evidence.
ALTER TABLE assets ADD COLUMN name TEXT;
CREATE TABLE asset_version_counters(asset_id TEXT PRIMARY KEY REFERENCES assets(id),next_version INTEGER NOT NULL CHECK(next_version>0));
INSERT INTO asset_version_counters SELECT a.id,COALESCE(MAX(v.version),0)+1 FROM assets a LEFT JOIN asset_versions v ON v.asset_id=a.id GROUP BY a.id;
CREATE TRIGGER asset_counter_created AFTER INSERT ON assets BEGIN INSERT INTO asset_version_counters VALUES(NEW.id,1); END;
CREATE TRIGGER version_counter_sync AFTER INSERT ON asset_versions BEGIN
 UPDATE asset_version_counters SET next_version=MAX(next_version,NEW.version+1) WHERE asset_id=NEW.asset_id;
END;
ALTER TABLE asset_version_state_history ADD COLUMN actor_role TEXT;
ALTER TABLE approvals ADD COLUMN approver_role TEXT;
DROP TRIGGER final_decision_authority;
CREATE TRIGGER final_decision_authority BEFORE UPDATE ON asset_version_states WHEN NEW.status IN ('APPROVED','REJECTED','FINAL') AND NOT EXISTS(
 SELECT 1 FROM asset_versions v JOIN assets a ON a.id=v.asset_id JOIN project_members m ON m.project_id=a.project_id
 WHERE v.id=NEW.asset_version_id AND m.user_id=NEW.actor_user_id AND m.status='ACTIVE'
 AND ((NEW.status='FINAL' AND m.role='OWNER') OR (NEW.status IN ('APPROVED','REJECTED') AND m.role IN ('OWNER','MANAGER','REVIEWER'))))
 BEGIN SELECT RAISE(ABORT,'project role cannot make this decision'); END;
CREATE TRIGGER rejection_comment_required BEFORE UPDATE ON asset_version_states WHEN NEW.status='REJECTED' AND length(trim(NEW.reason))=0 BEGIN SELECT RAISE(ABORT,'rejection comment required'); END;
DROP TRIGGER version_state_created;
CREATE TRIGGER version_state_created AFTER INSERT ON asset_versions BEGIN
 INSERT INTO asset_version_states VALUES(NEW.id,NEW.status,NEW.created_by,'',NEW.created_at);
 INSERT INTO asset_version_state_history(asset_version_id,to_status,actor_user_id,created_at,actor_role)
 SELECT NEW.id,NEW.status,NEW.created_by,NEW.created_at,m.role FROM assets a LEFT JOIN project_members m ON m.project_id=a.project_id AND m.user_id=NEW.created_by WHERE a.id=NEW.asset_id;
 INSERT INTO audit_events(project_id,actor_user_id,event_type,target_type,target_id,metadata_json,created_at)
 SELECT a.project_id,NEW.created_by,'VERSION_CREATED','asset_version',NEW.id,json_object('asset_id',NEW.asset_id,'asset_version_id',NEW.id,'version',NEW.version,'actor_role',m.role),NEW.created_at FROM assets a LEFT JOIN project_members m ON m.project_id=a.project_id AND m.user_id=NEW.created_by WHERE a.id=NEW.asset_id;
END;
DROP TRIGGER state_transition_history;
CREATE TRIGGER state_transition_history AFTER UPDATE ON asset_version_states BEGIN
 INSERT INTO asset_version_state_history(asset_version_id,from_status,to_status,actor_user_id,reason,created_at,actor_role)
 SELECT NEW.asset_version_id,OLD.status,NEW.status,NEW.actor_user_id,NEW.reason,NEW.updated_at,m.role FROM asset_versions v JOIN assets a ON a.id=v.asset_id LEFT JOIN project_members m ON m.project_id=a.project_id AND m.user_id=NEW.actor_user_id WHERE v.id=NEW.asset_version_id;
 INSERT INTO audit_events(project_id,actor_user_id,event_type,target_type,target_id,metadata_json,created_at)
 SELECT a.project_id,NEW.actor_user_id,'VERSION_'||CASE NEW.status WHEN 'FINAL' THEN 'FINALIZED' ELSE NEW.status END,'asset_version',NEW.asset_version_id,json_object('asset_id',a.id,'asset_version_id',v.id,'version',v.version,'actor_role',m.role),NEW.updated_at FROM assets a JOIN asset_versions v ON v.asset_id=a.id LEFT JOIN project_members m ON m.project_id=a.project_id AND m.user_id=NEW.actor_user_id WHERE v.id=NEW.asset_version_id;
 INSERT INTO approvals(id,asset_version_id,approver_id,status,comment,created_at,approver_role)
 SELECT lower(hex(randomblob(16))),NEW.asset_version_id,NEW.actor_user_id,NEW.status,NEW.reason,NEW.updated_at,m.role FROM asset_versions v JOIN assets a ON a.id=v.asset_id LEFT JOIN project_members m ON m.project_id=a.project_id AND m.user_id=NEW.actor_user_id WHERE v.id=NEW.asset_version_id AND NEW.status IN ('APPROVED','REJECTED');
END;
