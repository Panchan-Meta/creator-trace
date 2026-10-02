-- Additive: existing certificates, approvals and audit history are preserved.
CREATE TABLE bot_bindings (
 id TEXT PRIMARY KEY, internal_agent_id TEXT NOT NULL UNIQUE,
 display_name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('PM','Engineering','Security','Compliance','Customer')),
 credential_key_id TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE workflow_runs (
 id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES issuance_batches(id),
 workflow_type TEXT NOT NULL CHECK(workflow_type='bot_review'),
 status TEXT NOT NULL CHECK(status IN ('IN_PROGRESS','COMPLETED')),
 started_at TEXT NOT NULL, completed_at TEXT, created_at TEXT NOT NULL,
 UNIQUE(id,batch_id), UNIQUE(batch_id,workflow_type)
);
CREATE TABLE bot_reviews (
 id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, batch_id TEXT NOT NULL,
 agent_id TEXT NOT NULL REFERENCES bot_bindings(internal_agent_id),
 role TEXT NOT NULL CHECK(role IN ('PM','Engineering','Security','Compliance','Customer')),
 result TEXT NOT NULL CHECK(result IN ('pass','concern','needs_human_review')),
 risk_level TEXT NOT NULL CHECK(risk_level IN ('low','medium','high')),
 recommendation TEXT NOT NULL CHECK(recommendation IN ('continue_review','hold','escalate_to_punka')),
 summary TEXT NOT NULL, issues_json TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL,
 created_at TEXT NOT NULL,
 FOREIGN KEY(workflow_run_id,batch_id) REFERENCES workflow_runs(id,batch_id),
 UNIQUE(workflow_run_id,agent_id)
);
CREATE INDEX bot_reviews_batch ON bot_reviews(batch_id,created_at);
CREATE TRIGGER bot_review_role_guard BEFORE INSERT ON bot_reviews WHEN NOT EXISTS (
 SELECT 1 FROM bot_bindings WHERE internal_agent_id=NEW.agent_id AND role=NEW.role AND enabled=1
) BEGIN SELECT RAISE(ABORT,'enabled matching bot required'); END;
CREATE TRIGGER bot_review_no_update BEFORE UPDATE ON bot_reviews BEGIN SELECT RAISE(ABORT,'review is immutable'); END;
CREATE TRIGGER bot_review_no_delete BEFORE DELETE ON bot_reviews BEGIN SELECT RAISE(ABORT,'review history is permanent'); END;
INSERT INTO bot_bindings VALUES('tachibana','tachibana_pm','橘 司','PM','MCP_TACHIBANA_TOKEN',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT INTO bot_bindings VALUES('sanada','sanada_engineering','真田 蓮','Engineering','MCP_SANADA_TOKEN',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT INTO bot_bindings VALUES('mido','mido_security','御堂 玲','Security','MCP_MIDO_TOKEN',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT INTO bot_bindings VALUES('shiraishi','shiraishi_compliance','白石 律','Compliance','MCP_SHIRAISHI_TOKEN',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT INTO bot_bindings VALUES('mizuki','mizuki_customer','水城 澪','Customer','MCP_MIZUKI_TOKEN',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
