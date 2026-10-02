CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS certificates (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    title TEXT NOT NULL,
    certificate_type TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS timestamp_proofs (
    id TEXT PRIMARY KEY,
    certificate_id TEXT NOT NULL,
    r2_key TEXT,
    status TEXT NOT NULL,
    bitcoin_block INTEGER,
    created_at TEXT NOT NULL,
    verified_at TEXT
);
