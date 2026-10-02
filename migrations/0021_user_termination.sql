-- Additive: all existing users remain ACTIVE and all existing credentials stay valid.
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','TERMINATED'));
ALTER TABLE users ADD COLUMN terminated_at TEXT;
ALTER TABLE users ADD COLUMN terminated_by_admin_id TEXT REFERENCES users(id);
ALTER TABLE users ADD COLUMN termination_reason TEXT;
ALTER TABLE webauthn_credentials ADD COLUMN revoked_at TEXT;
ALTER TABLE webauthn_credentials ADD COLUMN revoked_by_admin_id TEXT REFERENCES users(id);
CREATE INDEX active_credentials ON webauthn_credentials(recipient_id,revoked_at);
CREATE TRIGGER users_history_no_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT,'user history is permanent'); END;
CREATE TRIGGER users_active_creation BEFORE INSERT ON users WHEN NEW.status!='ACTIVE' OR NEW.terminated_at IS NOT NULL OR NEW.terminated_by_admin_id IS NOT NULL OR NEW.termination_reason IS NOT NULL
 BEGIN SELECT RAISE(ABORT,'new user must be active'); END;
CREATE TRIGGER user_termination_guard BEFORE UPDATE OF status,terminated_at,terminated_by_admin_id,termination_reason ON users WHEN
 (OLD.status='TERMINATED' AND (NEW.status IS NOT OLD.status OR NEW.terminated_at IS NOT OLD.terminated_at OR NEW.terminated_by_admin_id IS NOT OLD.terminated_by_admin_id OR NEW.termination_reason IS NOT OLD.termination_reason))
 OR (NEW.status='ACTIVE' AND (NEW.terminated_at IS NOT NULL OR NEW.terminated_by_admin_id IS NOT NULL OR NEW.termination_reason IS NOT NULL))
 OR (OLD.status='ACTIVE' AND NEW.status='TERMINATED' AND (
  NEW.terminated_at IS NULL OR NEW.termination_reason IS NULL OR NEW.terminated_by_admin_id IS NULL OR NEW.terminated_by_admin_id=OLD.id
  OR EXISTS(SELECT 1 FROM site_admins WHERE user_id=OLD.id)
  OR NOT EXISTS(SELECT 1 FROM site_admins a JOIN users u ON u.id=a.user_id WHERE a.user_id=NEW.terminated_by_admin_id AND u.status='ACTIVE')))
 BEGIN SELECT RAISE(ABORT,'admin termination required; admins are protected'); END;
-- The UPDATE and all effects below form one atomic statement. Any failure rolls back everything.
CREATE TRIGGER user_termination_effects AFTER UPDATE OF status ON users WHEN OLD.status='ACTIVE' AND NEW.status='TERMINATED' BEGIN
 INSERT INTO audit_events(actor_user_id,event_type,target_type,target_id,metadata_json,created_at)
 VALUES(NEW.terminated_by_admin_id,'USER_TERMINATED','user',NEW.id,json_object('target_user_id',NEW.id,'terminated_by_admin_id',NEW.terminated_by_admin_id,'reason',NEW.termination_reason,'terminated_at',NEW.terminated_at,
 'session_count',(SELECT count(*) FROM sessions WHERE recipient_id=NEW.id),
 'passkey_count',(SELECT count(*) FROM webauthn_credentials WHERE recipient_id=NEW.id AND revoked_at IS NULL),
 'api_key_count',(SELECT count(*) FROM api_keys WHERE user_id=NEW.id AND revoked_at IS NULL),
 'archived_project_count',(SELECT count(*) FROM projects p WHERE p.archived_at IS NULL AND EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=NEW.id AND m.role='OWNER' AND m.status='ACTIVE'))),NEW.terminated_at);
 INSERT INTO audit_events(actor_user_id,event_type,target_type,target_id,metadata_json,created_at)
 SELECT NEW.terminated_by_admin_id,'SESSION_REVOKED','user',NEW.id,json_object('target_user_id',NEW.id,'terminated_by_admin_id',NEW.terminated_by_admin_id,'session_count',count(*),'terminated_at',NEW.terminated_at),NEW.terminated_at FROM sessions WHERE recipient_id=NEW.id;
 INSERT INTO audit_events(actor_user_id,event_type,target_type,target_id,metadata_json,created_at)
 SELECT NEW.terminated_by_admin_id,'PASSKEY_REVOKED','user',NEW.id,json_object('target_user_id',NEW.id,'terminated_by_admin_id',NEW.terminated_by_admin_id,'passkey_count',count(*),'terminated_at',NEW.terminated_at),NEW.terminated_at FROM webauthn_credentials WHERE recipient_id=NEW.id AND revoked_at IS NULL;
 INSERT INTO audit_events(actor_user_id,event_type,target_type,target_id,metadata_json,created_at)
 SELECT NEW.terminated_by_admin_id,'API_KEYS_REVOKED','user',NEW.id,json_object('target_user_id',NEW.id,'terminated_by_admin_id',NEW.terminated_by_admin_id,'api_key_count',count(*),'terminated_at',NEW.terminated_at),NEW.terminated_at FROM api_keys WHERE user_id=NEW.id AND revoked_at IS NULL;
 INSERT INTO audit_events(project_id,actor_user_id,event_type,target_type,target_id,metadata_json,created_at)
 SELECT p.id,NEW.terminated_by_admin_id,'PROJECT_ARCHIVED_BY_TERMINATION','project',p.id,json_object('target_user_id',NEW.id,'terminated_by_admin_id',NEW.terminated_by_admin_id,'project_id',p.id,'reason',NEW.termination_reason,'terminated_at',NEW.terminated_at),NEW.terminated_at
 FROM projects p WHERE p.archived_at IS NULL AND EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=NEW.id AND m.role='OWNER' AND m.status='ACTIVE');
 DELETE FROM sessions WHERE recipient_id=NEW.id;
 UPDATE webauthn_credentials SET revoked_at=NEW.terminated_at,revoked_by_admin_id=NEW.terminated_by_admin_id WHERE recipient_id=NEW.id AND revoked_at IS NULL;
 UPDATE api_keys SET revoked_at=NEW.terminated_at WHERE user_id=NEW.id AND revoked_at IS NULL;
 UPDATE enrollment_tokens SET consumed_at=NEW.terminated_at WHERE recipient_id=NEW.id AND consumed_at IS NULL;
 DELETE FROM auth_challenges WHERE recipient_id=NEW.id OR enrollment_hash IN (SELECT token_hash FROM enrollment_tokens WHERE recipient_id=NEW.id);
 UPDATE account_activations SET status='REVOKED',revoked_at=NEW.terminated_at,revoked_by_admin_id=NEW.terminated_by_admin_id WHERE status='PENDING' AND (user_id=NEW.id OR lower(email)=lower(NEW.email));
 DELETE FROM account_activation_registrations WHERE activation_id IN (SELECT id FROM account_activations WHERE status='REVOKED' AND (user_id=NEW.id OR lower(email)=lower(NEW.email)));
 UPDATE projects SET archived_at=COALESCE(archived_at,NEW.terminated_at) WHERE EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=projects.id AND m.user_id=NEW.id AND m.role='OWNER' AND m.status='ACTIVE');
END;
-- Enforce account state at credential issuance too, including requests already in flight.
CREATE TRIGGER session_active_user BEFORE INSERT ON sessions WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.recipient_id AND status='ACTIVE') BEGIN SELECT RAISE(ABORT,'account inactive'); END;
CREATE TRIGGER passkey_active_user BEFORE INSERT ON webauthn_credentials WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.recipient_id AND status='ACTIVE') BEGIN SELECT RAISE(ABORT,'account inactive'); END;
CREATE TRIGGER api_key_active_user BEFORE INSERT ON api_keys WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND status='ACTIVE') BEGIN SELECT RAISE(ABORT,'account inactive'); END;
CREATE TRIGGER last_active_passkey_guard BEFORE DELETE ON webauthn_credentials WHEN OLD.revoked_at IS NULL AND (SELECT count(*) FROM webauthn_credentials WHERE recipient_id=OLD.recipient_id AND revoked_at IS NULL)<=1 BEGIN SELECT RAISE(ABORT,'last active passkey cannot be removed'); END;
CREATE TRIGGER passkey_revocation_terminal BEFORE UPDATE OF revoked_at,revoked_by_admin_id ON webauthn_credentials WHEN OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS NOT OLD.revoked_at OR NEW.revoked_by_admin_id IS NOT OLD.revoked_by_admin_id) BEGIN SELECT RAISE(ABORT,'credential revocation is permanent'); END;
