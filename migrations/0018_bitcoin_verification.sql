-- Additive only: preserve all receipt, Version, approval and audit history.
ALTER TABLE proofs ADD COLUMN bitcoin_block_height INTEGER;
ALTER TABLE proofs ADD COLUMN bitcoin_block_hash TEXT;
ALTER TABLE proofs ADD COLUMN bitcoin_block_time TEXT;
ALTER TABLE proofs ADD COLUMN bitcoin_verification_state TEXT CHECK(bitcoin_verification_state IN ('OTS_CREATED','WAITING_BITCOIN','BITCOIN_ANCHOR_FOUND','BITCOIN_VERIFIED','VERIFY_FAILED'));
CREATE TABLE bitcoin_verification_attempts (
 id TEXT PRIMARY KEY,
 proof_id TEXT NOT NULL REFERENCES proofs(id),
 actor_user_id TEXT REFERENCES users(id),
 state TEXT NOT NULL CHECK(state IN ('OTS_CREATED','WAITING_BITCOIN','BITCOIN_ANCHOR_FOUND','BITCOIN_VERIFIED','VERIFY_FAILED')),
 provider TEXT CHECK(provider IN ('ESPLORA','RPC')),
 block_height INTEGER,
 block_hash TEXT,
 block_time TEXT,
 confirmations INTEGER,
 error_code TEXT,
 checked_at TEXT NOT NULL
);
CREATE INDEX bitcoin_attempts_proof ON bitcoin_verification_attempts(proof_id,checked_at DESC);
CREATE TRIGGER bitcoin_attempts_no_update BEFORE UPDATE ON bitcoin_verification_attempts BEGIN SELECT RAISE(ABORT,'verification history is immutable'); END;
CREATE TRIGGER bitcoin_attempts_no_delete BEFORE DELETE ON bitcoin_verification_attempts BEGIN SELECT RAISE(ABORT,'verification history is permanent'); END;
CREATE TRIGGER bitcoin_confirmed_metadata_guard BEFORE UPDATE OF bitcoin_block_height,bitcoin_block_hash,bitcoin_block_time,bitcoin_verification_state ON proofs WHEN OLD.proof_status='CONFIRMED' BEGIN SELECT RAISE(ABORT,'confirmed proof is immutable'); END;
