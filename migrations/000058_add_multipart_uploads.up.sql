-- Track active S3 multipart uploads per user for authorization and cleanup
CREATE TABLE multipart_uploads (
    upload_id TEXT PRIMARY KEY,
    video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_key TEXT NOT NULL,
    initiated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_multipart_uploads_user ON multipart_uploads(user_id);
CREATE INDEX idx_multipart_uploads_initiated_at ON multipart_uploads(initiated_at);
