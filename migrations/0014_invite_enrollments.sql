-- Invitation enrollment registers a user and Passkey without a new project.
CREATE TABLE invite_enrollments (
 token_hash TEXT PRIMARY KEY REFERENCES enrollment_tokens(token_hash),
 invite_id TEXT NOT NULL REFERENCES project_invites(id),
 created_at TEXT NOT NULL
);
