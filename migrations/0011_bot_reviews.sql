-- AI advice is isolated from production state and retained as append-only history.
CREATE TABLE bot_review_runs(
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),asset_version_id TEXT NOT NULL REFERENCES asset_versions(id),
 status TEXT NOT NULL CHECK(status IN ('RUNNING','COMPLETED','FAILED')),model TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),
 started_at TEXT NOT NULL,completed_at TEXT,error_message TEXT,created_at TEXT NOT NULL,
 context_json TEXT NOT NULL,prompt_version TEXT NOT NULL DEFAULT 'creator-review-v1'
);
CREATE UNIQUE INDEX bot_review_running_version ON bot_review_runs(asset_version_id) WHERE status='RUNNING';
CREATE INDEX bot_review_version_history ON bot_review_runs(project_id,asset_version_id,created_at DESC);
CREATE TABLE bot_review_messages(
 id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES bot_review_runs(id),bot_key TEXT NOT NULL CHECK(bot_key IN ('sanada','mido','shiraishi','mizuki','tachibana')),
 bot_name TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(run_id,bot_key)
);
CREATE TRIGGER bot_review_run_identity BEFORE UPDATE ON bot_review_runs
WHEN OLD.status!='RUNNING' OR NEW.status NOT IN ('COMPLETED','FAILED') OR NEW.id IS NOT OLD.id
 OR NEW.project_id IS NOT OLD.project_id OR NEW.asset_version_id IS NOT OLD.asset_version_id
 OR NEW.model IS NOT OLD.model OR NEW.created_by IS NOT OLD.created_by OR NEW.started_at IS NOT OLD.started_at
 OR NEW.created_at IS NOT OLD.created_at OR NEW.context_json IS NOT OLD.context_json OR NEW.prompt_version IS NOT OLD.prompt_version
BEGIN SELECT RAISE(ABORT,'review run is immutable'); END;
CREATE TRIGGER bot_review_run_project BEFORE INSERT ON bot_review_runs
WHEN NOT EXISTS(SELECT 1 FROM asset_versions v JOIN assets a ON a.id=v.asset_id WHERE v.id=NEW.asset_version_id AND a.project_id=NEW.project_id)
BEGIN SELECT RAISE(ABORT,'review project mismatch'); END;
CREATE TRIGGER bot_review_run_no_delete BEFORE DELETE ON bot_review_runs BEGIN SELECT RAISE(ABORT,'review history is permanent'); END;
CREATE TRIGGER bot_review_message_no_update BEFORE UPDATE ON bot_review_messages BEGIN SELECT RAISE(ABORT,'review message is immutable'); END;
CREATE TRIGGER bot_review_message_no_delete BEFORE DELETE ON bot_review_messages BEGIN SELECT RAISE(ABORT,'review message is permanent'); END;
CREATE TRIGGER bot_review_message_running BEFORE INSERT ON bot_review_messages
WHEN NOT EXISTS(SELECT 1 FROM bot_review_runs WHERE id=NEW.run_id AND status='RUNNING')
BEGIN SELECT RAISE(ABORT,'review run is not running'); END;
CREATE TRIGGER bot_review_run_complete_guard BEFORE UPDATE OF status ON bot_review_runs
WHEN NEW.status='COMPLETED' AND (SELECT COUNT(*) FROM bot_review_messages WHERE run_id=NEW.id)!=5
BEGIN SELECT RAISE(ABORT,'five reviews required'); END;
CREATE TRIGGER bot_review_started AFTER INSERT ON bot_review_runs BEGIN
 INSERT INTO audit_events(project_id,actor_user_id,event_type,target_type,target_id,created_at) VALUES(NEW.project_id,NEW.created_by,'BOT_REVIEW_STARTED','bot_review_run',NEW.id,NEW.started_at);
END;
CREATE TRIGGER bot_review_finished AFTER UPDATE ON bot_review_runs BEGIN
 INSERT INTO audit_events(project_id,actor_user_id,event_type,target_type,target_id,created_at) VALUES(NEW.project_id,NEW.created_by,'BOT_REVIEW_'||NEW.status,'bot_review_run',NEW.id,NEW.completed_at);
END;
