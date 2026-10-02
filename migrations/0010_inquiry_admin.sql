-- Site administration is independent of project membership and display names.
CREATE TABLE site_admins(user_id TEXT PRIMARY KEY REFERENCES users(id),created_at TEXT NOT NULL);
ALTER TABLE business_inquiries ADD COLUMN archived_at TEXT;
CREATE INDEX business_inquiries_management ON business_inquiries(archived_at,status,created_at DESC);
CREATE TRIGGER inquiry_content_immutable BEFORE UPDATE ON business_inquiries
WHEN NEW.id IS NOT OLD.id OR NEW.name IS NOT OLD.name OR NEW.company IS NOT OLD.company
 OR NEW.email IS NOT OLD.email OR NEW.team_size IS NOT OLD.team_size
 OR NEW.current_tools IS NOT OLD.current_tools OR NEW.problem IS NOT OLD.problem
 OR NEW.message IS NOT OLD.message OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'inquiry content is immutable'); END;
CREATE TRIGGER inquiry_no_delete BEFORE DELETE ON business_inquiries
BEGIN SELECT RAISE(ABORT,'inquiry is permanent; use archived_at'); END;
CREATE TRIGGER inquiry_status_insert BEFORE INSERT ON business_inquiries
WHEN NEW.status NOT IN ('NEW','IN_PROGRESS','COMPLETED')
BEGIN SELECT RAISE(ABORT,'invalid inquiry status'); END;
CREATE TRIGGER inquiry_status_update BEFORE UPDATE OF status ON business_inquiries
WHEN NEW.status NOT IN ('NEW','IN_PROGRESS','COMPLETED')
BEGIN SELECT RAISE(ABORT,'invalid inquiry status'); END;
