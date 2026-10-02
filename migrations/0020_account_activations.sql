-- Additive only: existing users, credentials, projects and evidence are retained.
CREATE TABLE account_activations (
 id TEXT PRIMARY KEY,
 email TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','ACTIVATED','EXPIRED','REVOKED')),
 expires_at TEXT NOT NULL,
 activated_at TEXT,
 user_id TEXT REFERENCES users(id),
 created_by_admin_id TEXT NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL,
 revoked_at TEXT,
 revoked_by_admin_id TEXT REFERENCES users(id),
 CHECK((status='ACTIVATED' AND user_id IS NOT NULL AND activated_at IS NOT NULL) OR (status!='ACTIVATED' AND user_id IS NULL AND activated_at IS NULL))
);
CREATE UNIQUE INDEX activation_pending_email ON account_activations(email) WHERE status='PENDING';
CREATE INDEX activation_expiry ON account_activations(status,expires_at);
-- Only hashed browser context is retained. No user exists until verification succeeds.
CREATE TABLE account_activation_registrations (
 challenge_hash TEXT PRIMARY KEY,
 activation_id TEXT NOT NULL REFERENCES account_activations(id),
 browser_hash TEXT NOT NULL,
 reserved_user_id TEXT NOT NULL,
 display_name TEXT NOT NULL,
 expires_at TEXT NOT NULL
);
CREATE TRIGGER activation_issuer_guard BEFORE INSERT ON account_activations WHEN
 NOT EXISTS(SELECT 1 FROM site_admins WHERE user_id=NEW.created_by_admin_id)
 OR EXISTS(SELECT 1 FROM users WHERE lower(email)=NEW.email)
 BEGIN SELECT RAISE(ABORT,'admin issuance for new user required'); END;
CREATE TRIGGER activation_transition_guard BEFORE UPDATE ON account_activations WHEN
 OLD.status!='PENDING' OR NEW.status NOT IN ('ACTIVATED','EXPIRED','REVOKED')
 OR NEW.id!=OLD.id OR NEW.email!=OLD.email OR NEW.token_hash!=OLD.token_hash
 OR NEW.expires_at!=OLD.expires_at OR NEW.created_by_admin_id!=OLD.created_by_admin_id OR NEW.created_at!=OLD.created_at
 OR (NEW.status='ACTIVATED' AND (OLD.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') OR (SELECT count(*) FROM users WHERE lower(email)=NEW.email)!=1 OR NOT EXISTS(SELECT 1 FROM users u JOIN webauthn_credentials c ON c.recipient_id=u.id WHERE u.id=NEW.user_id AND u.email=NEW.email)))
 OR (NEW.status='REVOKED' AND NOT EXISTS(SELECT 1 FROM site_admins WHERE user_id=NEW.revoked_by_admin_id))
 OR (NEW.status='EXPIRED' AND OLD.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'activation unavailable'); END;
CREATE TRIGGER activation_no_delete BEFORE DELETE ON account_activations BEGIN SELECT RAISE(ABORT,'activation history is permanent'); END;
CREATE TRIGGER activation_created_audit AFTER INSERT ON account_activations BEGIN
 INSERT INTO audit_events(actor_user_id,event_type,target_type,target_id,metadata_json,created_at)
 VALUES(NEW.created_by_admin_id,'ACCOUNT_ACTIVATION_CREATED','account_activation',NEW.id,json_object('activation_id',NEW.id,'actor_user_id',NEW.created_by_admin_id),NEW.created_at);
END;
CREATE TRIGGER activation_status_audit AFTER UPDATE OF status ON account_activations BEGIN
 INSERT INTO audit_events(actor_user_id,event_type,target_type,target_id,metadata_json,created_at)
 VALUES(CASE NEW.status WHEN 'ACTIVATED' THEN NEW.user_id WHEN 'REVOKED' THEN NEW.revoked_by_admin_id ELSE NULL END,
 CASE NEW.status WHEN 'ACTIVATED' THEN 'ACCOUNT_ACTIVATED' WHEN 'REVOKED' THEN 'ACCOUNT_ACTIVATION_REVOKED' ELSE 'ACCOUNT_ACTIVATION_EXPIRED' END,
 'account_activation',NEW.id,json_object('activation_id',NEW.id,'user_id',NEW.user_id,'actor_user_id',CASE NEW.status WHEN 'ACTIVATED' THEN NEW.user_id WHEN 'REVOKED' THEN NEW.revoked_by_admin_id ELSE NULL END),
 COALESCE(NEW.activated_at,NEW.revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')));
END;
CREATE TRIGGER owner_assigned_audit AFTER INSERT ON project_members WHEN NEW.role='OWNER' BEGIN
 INSERT INTO audit_events(project_id,actor_user_id,event_type,target_type,target_id,metadata_json,created_at)
 VALUES(NEW.project_id,NEW.user_id,'OWNER_ASSIGNED','member',NEW.id,json_object('user_id',NEW.user_id,'project_id',NEW.project_id,'actor_user_id',NEW.user_id),NEW.created_at);
END;
