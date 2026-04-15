package video

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/sendrec/sendrec/internal/auth"
	"github.com/sendrec/sendrec/internal/database"
	"github.com/sendrec/sendrec/internal/httputil"
)

// Multipart uploads are tracked in the multipart_uploads table to:
// 1. Validate that the uploadId belongs to the current user (authorization)
// 2. Clean up orphan uploads via a background worker (cost protection)
const maxActiveMultipartPerUser = 5

type initMultipartResponse struct {
	UploadID string `json:"uploadId"`
	Key      string `json:"key"`
}

// InitMultipart starts an S3 multipart upload for a video owned by the user.
func (h *Handler) InitMultipart(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	videoID := chi.URLParam(r, "id")

	// Rate limiting : max N uploads multipart actifs par user
	var activeCount int
	if err := h.db.QueryRow(r.Context(),
		`SELECT count(*) FROM multipart_uploads WHERE user_id = $1`, userID,
	).Scan(&activeCount); err != nil {
		slog.Error("multipart: count active", "error", err)
		httputil.WriteError(w, http.StatusInternalServerError, "failed to check quota")
		return
	}
	if activeCount >= maxActiveMultipartPerUser {
		httputil.WriteError(w, http.StatusTooManyRequests, "too many active multipart uploads")
		return
	}

	var fileKey, contentType string
	err := h.db.QueryRow(r.Context(),
		`SELECT file_key, content_type FROM videos WHERE id = $1 AND user_id = $2`,
		videoID, userID,
	).Scan(&fileKey, &contentType)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httputil.WriteError(w, http.StatusNotFound, "video not found")
		} else {
			slog.Error("multipart: video lookup", "error", err)
			httputil.WriteError(w, http.StatusInternalServerError, "database error")
		}
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	uploadID, err := h.storage.InitMultipartUpload(ctx, fileKey, contentType)
	if err != nil {
		slog.Error("multipart: S3 init failed", "error", err)
		httputil.WriteError(w, http.StatusInternalServerError, "failed to init multipart")
		return
	}

	// Track l'upload pour authorization + cleanup
	if _, err := h.db.Exec(r.Context(),
		`INSERT INTO multipart_uploads (upload_id, video_id, user_id, file_key) VALUES ($1, $2, $3, $4)`,
		uploadID, videoID, userID, fileKey,
	); err != nil {
		slog.Error("multipart: track insert failed, aborting S3 upload", "error", err)
		// Cleanup S3 puisqu'on ne peut pas tracker
		_ = h.storage.AbortMultipartUpload(ctx, fileKey, uploadID)
		httputil.WriteError(w, http.StatusInternalServerError, "failed to track upload")
		return
	}

	httputil.WriteJSON(w, http.StatusOK, initMultipartResponse{
		UploadID: uploadID,
		Key:      fileKey,
	})
}

type partURLResponse struct {
	URL string `json:"url"`
}

// GetPartURL returns a presigned URL for uploading a specific part.
// Only the user who initiated the multipart can request part URLs.
func (h *Handler) GetPartURL(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	videoID := chi.URLParam(r, "id")
	partNumberStr := chi.URLParam(r, "partNumber")
	uploadID := r.URL.Query().Get("uploadId")

	if uploadID == "" {
		httputil.WriteError(w, http.StatusBadRequest, "uploadId required")
		return
	}

	var partNumber int32
	if _, err := fmt.Sscanf(partNumberStr, "%d", &partNumber); err != nil || partNumber < 1 || partNumber > 10000 {
		httputil.WriteError(w, http.StatusBadRequest, "invalid part number")
		return
	}

	// Vérifier que l'uploadID appartient bien à ce user pour cette vidéo
	fileKey, err := h.verifyMultipartOwnership(r.Context(), uploadID, videoID, userID)
	if err != nil {
		if errors.Is(err, errMultipartNotFound) {
			httputil.WriteError(w, http.StatusNotFound, "multipart upload not found")
		} else {
			slog.Error("multipart: ownership check failed", "error", err)
			httputil.WriteError(w, http.StatusInternalServerError, "database error")
		}
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	url, err := h.storage.GeneratePartUploadURL(ctx, fileKey, uploadID, partNumber, 30*time.Minute)
	if err != nil {
		slog.Error("multipart: presign part failed", "error", err)
		httputil.WriteError(w, http.StatusInternalServerError, "failed to generate part URL")
		return
	}

	httputil.WriteJSON(w, http.StatusOK, partURLResponse{URL: url})
}

type completeMultipartRequest struct {
	UploadID string          `json:"uploadId"`
	Parts    []MultipartPart `json:"parts"`
}

// CompleteMultipart finalizes the upload by assembling the parts.
// On failure, the upload is automatically aborted to avoid orphan parts.
func (h *Handler) CompleteMultipart(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	videoID := chi.URLParam(r, "id")

	var req completeMultipartRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.UploadID == "" || len(req.Parts) == 0 {
		httputil.WriteError(w, http.StatusBadRequest, "uploadId and parts required")
		return
	}
	// Validation des parts : numéros et ETags non vides
	for i, p := range req.Parts {
		if p.PartNumber < 1 || p.PartNumber > 10000 {
			httputil.WriteError(w, http.StatusBadRequest, fmt.Sprintf("invalid partNumber at index %d", i))
			return
		}
		if p.ETag == "" {
			httputil.WriteError(w, http.StatusBadRequest, fmt.Sprintf("missing eTag at index %d", i))
			return
		}
	}

	fileKey, err := h.verifyMultipartOwnership(r.Context(), req.UploadID, videoID, userID)
	if err != nil {
		if errors.Is(err, errMultipartNotFound) {
			httputil.WriteError(w, http.StatusNotFound, "multipart upload not found")
		} else {
			slog.Error("multipart: ownership check failed", "error", err)
			httputil.WriteError(w, http.StatusInternalServerError, "database error")
		}
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	if err := h.storage.CompleteMultipartUpload(ctx, fileKey, req.UploadID, req.Parts); err != nil {
		slog.Error("multipart: S3 complete failed, aborting", "error", err, "upload_id", req.UploadID)
		// Best-effort cleanup S3 pour éviter les orphelins facturés
		abortCtx, abortCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer abortCancel()
		if abortErr := h.storage.AbortMultipartUpload(abortCtx, fileKey, req.UploadID); abortErr != nil {
			slog.Error("multipart: abort after failed complete also failed", "error", abortErr)
		}
		// Cleanup DB tracking
		_, _ = h.db.Exec(context.Background(), `DELETE FROM multipart_uploads WHERE upload_id = $1`, req.UploadID)
		httputil.WriteError(w, http.StatusInternalServerError, "failed to complete multipart")
		return
	}

	// Succès : retirer le tracking
	if _, err := h.db.Exec(r.Context(),
		`DELETE FROM multipart_uploads WHERE upload_id = $1`, req.UploadID,
	); err != nil {
		slog.Error("multipart: failed to delete tracking", "error", err, "upload_id", req.UploadID)
	}

	w.WriteHeader(http.StatusOK)
}

// AbortMultipart cancels a multipart upload (cleanup).
func (h *Handler) AbortMultipart(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	videoID := chi.URLParam(r, "id")
	uploadID := r.URL.Query().Get("uploadId")

	if uploadID == "" {
		httputil.WriteError(w, http.StatusBadRequest, "uploadId required")
		return
	}

	fileKey, err := h.verifyMultipartOwnership(r.Context(), uploadID, videoID, userID)
	if err != nil {
		if errors.Is(err, errMultipartNotFound) {
			// Idempotent : abort d'un upload déjà supprimé = OK
			w.WriteHeader(http.StatusNoContent)
		} else {
			slog.Error("multipart: ownership check failed", "error", err)
			httputil.WriteError(w, http.StatusInternalServerError, "database error")
		}
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	if err := h.storage.AbortMultipartUpload(ctx, fileKey, uploadID); err != nil {
		slog.Error("multipart: S3 abort failed", "error", err, "upload_id", uploadID)
		// On supprime quand même le tracking DB pour éviter le blocage
	}
	_, _ = h.db.Exec(r.Context(), `DELETE FROM multipart_uploads WHERE upload_id = $1`, uploadID)

	w.WriteHeader(http.StatusNoContent)
}

// errMultipartNotFound is returned when the uploadID doesn't exist or doesn't belong to the user.
var errMultipartNotFound = errors.New("multipart upload not found")

// verifyMultipartOwnership checks that the upload_id belongs to this user+video,
// and returns the file_key stored at init time.
func (h *Handler) verifyMultipartOwnership(ctx context.Context, uploadID, videoID, userID string) (string, error) {
	var fileKey string
	err := h.db.QueryRow(ctx,
		`SELECT file_key FROM multipart_uploads WHERE upload_id = $1 AND video_id = $2 AND user_id = $3`,
		uploadID, videoID, userID,
	).Scan(&fileKey)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", errMultipartNotFound
		}
		return "", err
	}
	return fileKey, nil
}

// StartMultipartCleanupWorker periodically aborts stale S3 multipart uploads.
// Stale = initiated more than 24h ago without being completed or aborted.
func StartMultipartCleanupWorker(ctx context.Context, db database.DBTX, storage ObjectStorage, interval time.Duration) {
	go func() {
		slog.Info("multipart-cleanup-worker: started")
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				slog.Info("multipart-cleanup-worker: shutting down")
				return
			case <-ticker.C:
				cleanupStaleMultiparts(ctx, db, storage)
			}
		}
	}()
}

func cleanupStaleMultiparts(ctx context.Context, db database.DBTX, storage ObjectStorage) {
	rows, err := db.Query(ctx,
		`SELECT upload_id, file_key FROM multipart_uploads WHERE initiated_at < now() - INTERVAL '24 hours'`,
	)
	if err != nil {
		slog.Error("multipart-cleanup: query failed", "error", err)
		return
	}
	defer rows.Close()

	type stale struct {
		uploadID string
		fileKey  string
	}
	var stales []stale
	for rows.Next() {
		var s stale
		if err := rows.Scan(&s.uploadID, &s.fileKey); err != nil {
			slog.Error("multipart-cleanup: scan failed", "error", err)
			continue
		}
		stales = append(stales, s)
	}

	for _, s := range stales {
		abortCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		if err := storage.AbortMultipartUpload(abortCtx, s.fileKey, s.uploadID); err != nil {
			slog.Error("multipart-cleanup: abort failed", "error", err, "upload_id", s.uploadID)
		} else {
			slog.Info("multipart-cleanup: aborted stale upload", "upload_id", s.uploadID)
		}
		cancel()

		if _, err := db.Exec(ctx, `DELETE FROM multipart_uploads WHERE upload_id = $1`, s.uploadID); err != nil {
			slog.Error("multipart-cleanup: delete tracking failed", "error", err)
		}
	}
}
