package video

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/sendrec/sendrec/internal/auth"
	"github.com/sendrec/sendrec/internal/httputil"
)

type initMultipartResponse struct {
	UploadID string `json:"uploadId"`
	Key      string `json:"key"`
}

// InitMultipart démarre un upload S3 multipart pour une vidéo.
// La vidéo doit déjà exister (créée via POST /api/videos) en statut "processing".
func (h *Handler) InitMultipart(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	videoID := chi.URLParam(r, "id")

	var fileKey string
	var contentType string
	err := h.db.QueryRow(r.Context(),
		`SELECT file_key, content_type FROM videos WHERE id = $1 AND user_id = $2`,
		videoID, userID,
	).Scan(&fileKey, &contentType)
	if err != nil {
		httputil.WriteError(w, http.StatusNotFound, "video not found")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	uploadID, err := h.storage.InitMultipartUpload(ctx, fileKey, contentType)
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to init multipart")
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

// GetPartURL retourne une URL presignée pour uploader un part spécifique.
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

	var fileKey string
	err := h.db.QueryRow(r.Context(),
		`SELECT file_key FROM videos WHERE id = $1 AND user_id = $2`,
		videoID, userID,
	).Scan(&fileKey)
	if err != nil {
		httputil.WriteError(w, http.StatusNotFound, "video not found")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	url, err := h.storage.GeneratePartUploadURL(ctx, fileKey, uploadID, partNumber, 30*time.Minute)
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to generate part URL")
		return
	}

	httputil.WriteJSON(w, http.StatusOK, partURLResponse{URL: url})
}

type completeMultipartRequest struct {
	UploadID string          `json:"uploadId"`
	Parts    []MultipartPart `json:"parts"`
}

// CompleteMultipart finalise l'upload multipart en assemblant les parts.
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

	var fileKey string
	err := h.db.QueryRow(r.Context(),
		`SELECT file_key FROM videos WHERE id = $1 AND user_id = $2`,
		videoID, userID,
	).Scan(&fileKey)
	if err != nil {
		httputil.WriteError(w, http.StatusNotFound, "video not found")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	if err := h.storage.CompleteMultipartUpload(ctx, fileKey, req.UploadID, req.Parts); err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to complete multipart")
		return
	}

	w.WriteHeader(http.StatusOK)
}

// AbortMultipart annule un upload multipart (cleanup).
func (h *Handler) AbortMultipart(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	videoID := chi.URLParam(r, "id")
	uploadID := r.URL.Query().Get("uploadId")

	if uploadID == "" {
		httputil.WriteError(w, http.StatusBadRequest, "uploadId required")
		return
	}

	var fileKey string
	err := h.db.QueryRow(r.Context(),
		`SELECT file_key FROM videos WHERE id = $1 AND user_id = $2`,
		videoID, userID,
	).Scan(&fileKey)
	if err != nil {
		httputil.WriteError(w, http.StatusNotFound, "video not found")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	if err := h.storage.AbortMultipartUpload(ctx, fileKey, uploadID); err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to abort multipart")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
