-- Additive migration: preserve all existing production and approval history.
CREATE TABLE project_approvers(
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),user_id TEXT NOT NULL REFERENCES users(id),
 granted_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,revoked_at TEXT,revoked_by TEXT REFERENCES users(id)
);
CREATE UNIQUE INDEX approvers_active ON project_approvers(project_id,user_id) WHERE revoked_at IS NULL;
CREATE TRIGGER approver_grant_guard BEFORE INSERT ON project_approvers WHEN
 NOT EXISTS(SELECT 1 FROM project_members WHERE project_id=NEW.project_id AND user_id=NEW.granted_by AND role='OWNER' AND status='ACTIVE') OR
 NOT EXISTS(SELECT 1 FROM project_members WHERE project_id=NEW.project_id AND user_id=NEW.user_id AND role='VIEWER' AND status='ACTIVE')
 BEGIN SELECT RAISE(ABORT,'owner and active viewer required'); END;
CREATE TRIGGER approver_update_guard BEFORE UPDATE ON project_approvers WHEN OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.revoked_by IS NULL
 OR NOT EXISTS(SELECT 1 FROM project_members WHERE project_id=NEW.project_id AND user_id=NEW.revoked_by AND role='OWNER' AND status='ACTIVE')
 OR NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.user_id IS NOT OLD.user_id OR NEW.granted_by IS NOT OLD.granted_by OR NEW.created_at IS NOT OLD.created_at
 BEGIN SELECT RAISE(ABORT,'approver grant is immutable'); END;
CREATE TRIGGER approver_no_delete BEFORE DELETE ON project_approvers BEGIN SELECT RAISE(ABORT,'approver history is permanent'); END;
CREATE TRIGGER approver_granted_audit AFTER INSERT ON project_approvers BEGIN
 INSERT INTO audit_events(project_id,actor_user_id,event_type,target_type,target_id,metadata_json,created_at) VALUES(NEW.project_id,NEW.granted_by,'APPROVER_GRANTED','member',NEW.user_id,json_object('grant_id',NEW.id),NEW.created_at);
END;
CREATE TRIGGER approver_revoked_audit AFTER UPDATE ON project_approvers BEGIN
 INSERT INTO audit_events(project_id,actor_user_id,event_type,target_type,target_id,metadata_json,created_at) VALUES(NEW.project_id,NEW.revoked_by,'APPROVER_REVOKED','member',NEW.user_id,json_object('grant_id',NEW.id),NEW.revoked_at);
END;
CREATE TRIGGER membership_revoke_approver AFTER UPDATE ON project_members WHEN NEW.status!='ACTIVE' OR NEW.role!='VIEWER' BEGIN
 UPDATE project_approvers SET revoked_at=COALESCE(NEW.removed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),revoked_by=COALESCE(NEW.removed_by,(SELECT owner_id FROM projects WHERE id=NEW.project_id)) WHERE project_id=NEW.project_id AND user_id=NEW.user_id AND revoked_at IS NULL;
END;
CREATE TABLE review_comments(
 id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES assets(id),version_id TEXT NOT NULL REFERENCES asset_versions(id),
 reviewer_id TEXT NOT NULL REFERENCES users(id),reviewer_name TEXT NOT NULL,comment TEXT NOT NULL CHECK(length(trim(comment)) BETWEEN 1 AND 4000),created_at TEXT NOT NULL
);
CREATE INDEX review_comments_artifact ON review_comments(artifact_id,created_at,id);
CREATE TRIGGER review_comment_guard BEFORE INSERT ON review_comments WHEN
 NOT EXISTS(SELECT 1 FROM asset_versions v JOIN assets a ON a.id=v.asset_id JOIN projects p ON p.id=a.project_id JOIN project_members m ON m.project_id=a.project_id
 WHERE v.id=NEW.version_id AND a.id=NEW.artifact_id AND a.archived_at IS NULL AND p.archived_at IS NULL AND m.user_id=NEW.reviewer_id AND m.role='REVIEWER' AND m.status='ACTIVE')
 BEGIN SELECT RAISE(ABORT,'active reviewer and matching version required'); END;
CREATE TRIGGER review_comment_no_update BEFORE UPDATE ON review_comments BEGIN SELECT RAISE(ABORT,'review comment is immutable'); END;
CREATE TRIGGER review_comment_no_delete BEFORE DELETE ON review_comments BEGIN SELECT RAISE(ABORT,'review comment is permanent'); END;
CREATE TRIGGER review_comment_audit AFTER INSERT ON review_comments BEGIN
 INSERT INTO audit_events(project_id,actor_user_id,event_type,target_type,target_id,metadata_json,created_at)
 SELECT project_id,NEW.reviewer_id,'REVIEW_COMMENT_ADDED','review_comment',NEW.id,json_object('artifact_id',NEW.artifact_id,'version_id',NEW.version_id,'reviewer_name',NEW.reviewer_name),NEW.created_at FROM assets WHERE id=NEW.artifact_id;
END;
-- Applies only to future transitions. Historical Reviewer decisions remain untouched.
CREATE TRIGGER final_decision_authority BEFORE UPDATE ON asset_version_states WHEN NEW.status IN ('APPROVED','REJECTED','FINAL') AND NOT EXISTS(
 SELECT 1 FROM asset_versions v JOIN assets a ON a.id=v.asset_id JOIN project_members m ON m.project_id=a.project_id
 WHERE v.id=NEW.asset_version_id AND m.user_id=NEW.actor_user_id AND m.status='ACTIVE' AND (m.role='OWNER' OR (m.role='VIEWER' AND EXISTS(SELECT 1 FROM project_approvers g WHERE g.project_id=m.project_id AND g.user_id=m.user_id AND g.revoked_at IS NULL))))
 BEGIN SELECT RAISE(ABORT,'owner or approver required'); END;
