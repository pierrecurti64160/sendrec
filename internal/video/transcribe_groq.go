package video

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Groq API pour Whisper Large V3 Turbo — 15-20x plus rapide que self-hosted.
// Limite 25 MB/requete sur le tier gratuit. On extrait l'audio en MP3 64 kbps
// pour rester sous la limite meme pour des videos d'1 h.

const groqAPIURL = "https://api.groq.com/openai/v1/audio/transcriptions"
const groqModel = "whisper-large-v3-turbo"
const groqMaxBytes = 25 * 1024 * 1024

func isGroqAvailable() bool {
	return os.Getenv("GROQ_API_KEY") != ""
}

// Extrait l'audio en MP3 64 kbps mono. Un MP3 64 kbps fait ~480 KB/min,
// soit ~29 MB pour 1 h. Sous la limite 25 MB jusqu'a 50 min environ.
func extractAudioMP3(inputPath, outputPath string) error {
	if !hasAudioStream(inputPath) {
		return errNoAudio
	}
	cmd := exec.Command("ffmpeg",
		"-i", inputPath,
		"-vn",
		"-ac", "1",
		"-ar", "16000",
		"-b:a", "64k",
		"-c:a", "libmp3lame",
		"-y",
		outputPath,
	)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("ffmpeg mp3 extraction: %w: %s", err, string(output))
	}
	return nil
}

type groqSegment struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Text  string  `json:"text"`
}

type groqResponse struct {
	Text     string        `json:"text"`
	Segments []groqSegment `json:"segments"`
}

// Appelle l'API Groq et retourne les segments. Erreur explicite si > 25 MB,
// auth invalide, rate limit ou autre — le caller decide de fallback.
func transcribeWithGroq(ctx context.Context, audioPath, language string) ([]TranscriptSegment, error) {
	apiKey := os.Getenv("GROQ_API_KEY")
	if apiKey == "" {
		return nil, fmt.Errorf("groq: GROQ_API_KEY not set")
	}

	stat, err := os.Stat(audioPath)
	if err != nil {
		return nil, fmt.Errorf("groq: stat audio: %w", err)
	}
	if stat.Size() > groqMaxBytes {
		return nil, fmt.Errorf("groq: audio file %d bytes exceeds 25MB limit", stat.Size())
	}

	file, err := os.Open(audioPath)
	if err != nil {
		return nil, fmt.Errorf("groq: open audio: %w", err)
	}
	defer func() { _ = file.Close() }()

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)

	part, err := writer.CreateFormFile("file", "audio.mp3")
	if err != nil {
		return nil, fmt.Errorf("groq: create form file: %w", err)
	}
	if _, err := io.Copy(part, file); err != nil {
		return nil, fmt.Errorf("groq: copy file: %w", err)
	}

	_ = writer.WriteField("model", groqModel)
	_ = writer.WriteField("response_format", "verbose_json")
	if language != "" && language != "auto" {
		_ = writer.WriteField("language", language)
	}
	_ = writer.WriteField("temperature", "0")

	if err := writer.Close(); err != nil {
		return nil, fmt.Errorf("groq: close writer: %w", err)
	}

	reqCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, "POST", groqAPIURL, body)
	if err != nil {
		return nil, fmt.Errorf("groq: new request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", writer.FormDataContentType())

	client := &http.Client{Timeout: 3 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("groq: http: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("groq: read response: %w", err)
	}

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("groq: status %d: %s", resp.StatusCode, string(respBody))
	}

	var parsed groqResponse
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return nil, fmt.Errorf("groq: parse response: %w", err)
	}

	segments := make([]TranscriptSegment, 0, len(parsed.Segments))
	for _, seg := range parsed.Segments {
		text := strings.TrimSpace(seg.Text)
		if text == "" {
			continue
		}
		segments = append(segments, TranscriptSegment{
			Start: seg.Start,
			End:   seg.End,
			Text:  text,
		})
	}

	slog.Info("groq: transcription OK", "segments", len(segments), "bytes", stat.Size())
	return segments, nil
}

// Ecrit un fichier VTT a partir des segments. Reproduit le format attendu
// par le reste du pipeline (format identique a ce que produit whisper-cli).
func writeVTT(path string, segments []TranscriptSegment) error {
	var buf bytes.Buffer
	buf.WriteString("WEBVTT\n\n")
	for i, seg := range segments {
		fmt.Fprintf(&buf, "%d\n%s --> %s\n%s\n\n",
			i+1,
			formatVTTTime(seg.Start),
			formatVTTTime(seg.End),
			seg.Text,
		)
	}
	return os.WriteFile(path, buf.Bytes(), 0644)
}

func formatVTTTime(seconds float64) string {
	h := int(seconds) / 3600
	m := (int(seconds) % 3600) / 60
	s := seconds - float64(h*3600+m*60)
	return fmt.Sprintf("%02d:%02d:%06.3f", h, m, s)
}
