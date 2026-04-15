import { useCallback, useEffect, useRef, useState } from "react";
import { useDrawingCanvas } from "../hooks/useDrawingCanvas";
import { useCanvasCompositing } from "../hooks/useCanvasCompositing";
import { useMediaDevices } from "../hooks/useMediaDevices";
import { useRecording, MIN_RECORDING_SECONDS, MIN_RECORDING_BYTES } from "../hooks/useRecording";
import { getSupportedMimeType, blobTypeFromMimeType } from "../utils/mediaFormat";
import { formatDuration } from "../utils/format";

interface RecorderProps {
  onRecordingComplete: (blob: Blob, duration: number, webcamBlob?: Blob) => void;
  onRecordingError?: (message: string) => void;
  maxDurationSeconds?: number;
}

export function Recorder({ onRecordingComplete, onRecordingError, maxDurationSeconds = 0 }: RecorderProps) {
  const [webcamEnabled, setWebcamEnabled] = useState(() => localStorage.getItem("recording-mode") === "screen-camera");
  const [captureWidth, setCaptureWidth] = useState(1920);
  const [captureHeight, setCaptureHeight] = useState(1080);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [systemAudioEnabled, setSystemAudioEnabled] = useState(() => localStorage.getItem("recording-audio") !== "false");
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [notesText, setNotesText] = useState("");
  const [notesVisible, setNotesVisible] = useState(false);
  const notesWindowRef = useRef<Window | null>(null);
  const webcamPipVideoRef = useRef<HTMLVideoElement | null>(null);
  const devices = useMediaDevices();
  const countdownEnabled = useRef(localStorage.getItem("recording-countdown") !== "false");

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  const webcamStreamRef = useRef<MediaStream | null>(null);
  const webcamRecorderRef = useRef<MediaRecorder | null>(null);
  const webcamChunksRef = useRef<Blob[]>([]);
  const webcamBlobPromiseRef = useRef<Promise<Blob> | null>(null);
  const mimeTypeRef = useRef("");
  const webcamVideoCallbackRef = useCallback((node: HTMLVideoElement | null) => {
    if (node && webcamStreamRef.current) {
      node.srcObject = webcamStreamRef.current;
    }
  }, []);

  // Drawing and compositing refs
  const drawingCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositingCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);

  const {
    drawMode,
    drawColor,
    lineWidth,
    toggleDrawMode,
    setDrawColor,
    setLineWidth,
    clearCanvas,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerLeave,
  } = useDrawingCanvas({ canvasRef: drawingCanvasRef, captureWidth, captureHeight });

  const { startCompositing, stopCompositing } =
    useCanvasCompositing({
      compositingCanvasRef,
      screenVideoRef,
      drawingCanvasRef,
    });

  const stopWebcamStream = useCallback(() => {
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
    }
    if (webcamPipVideoRef.current) {
      webcamPipVideoRef.current.remove();
      webcamPipVideoRef.current = null;
    }
    if (webcamStreamRef.current) {
      webcamStreamRef.current.getTracks().forEach((track) => track.stop());
      webcamStreamRef.current = null;
    }
  }, []);

  const stopMicStream = useCallback(() => {
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((track) => track.stop());
      micStreamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
  }, []);

  const stopAllStreams = useCallback(() => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((track) => track.stop());
      screenStreamRef.current = null;
    }
    stopMicStream();
    stopWebcamStream();
  }, [stopMicStream, stopWebcamStream]);

  // Stable refs for callbacks passed to useRecording to avoid stale closure issues
  const stopRecordingRef = useRef<() => void>(() => {});
  const beginRecordingRef = useRef<() => void>(() => {});

  const recording = useRecording(
    maxDurationSeconds,
    () => beginRecordingRef.current(),
    () => stopRecordingRef.current(),
  );

  const stopRecording = useCallback(() => {
    const hasActiveRecorder = mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive";

    if (hasActiveRecorder) {
      if (mediaRecorderRef.current!.state === "paused") {
        recording.totalPausedRef.current += Date.now() - recording.pauseStartRef.current;
      }
      mediaRecorderRef.current!.stop();
    }
    if (webcamRecorderRef.current && webcamRecorderRef.current.state !== "inactive") {
      if (webcamRecorderRef.current.state === "paused") {
        webcamRecorderRef.current.resume();
      }
      webcamRecorderRef.current.stop();
    }
    recording.stopTimer();
    stopCompositing();
    if (screenVideoRef.current) {
      screenVideoRef.current.srcObject = null;
    }
    // When recording screenStream directly, we must NOT stop the stream tracks
    // until after MediaRecorder fires its async onstop event and produces the
    // final data. Stream cleanup happens in the recorder's onstop handler.
    // Only clean up immediately if there's no active recorder (e.g. abort paths).
    if (!hasActiveRecorder) {
      stopAllStreams();
    }
    recording.setState("stopped");
  }, [recording, stopAllStreams, stopCompositing]);

  const pauseRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.pause();
      if (webcamRecorderRef.current && webcamRecorderRef.current.state === "recording") {
        webcamRecorderRef.current.pause();
      }
      recording.pauseStartRef.current = Date.now();
      recording.stopTimer();
      recording.setState("paused");
    }
  }, [recording]);

  const resumeRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "paused") {
      recording.totalPausedRef.current += Date.now() - recording.pauseStartRef.current;
      mediaRecorderRef.current.resume();
      if (webcamRecorderRef.current && webcamRecorderRef.current.state === "paused") {
        webcamRecorderRef.current.resume();
      }
      recording.startTimer();
      recording.setState("recording");
    }
  }, [recording]);

  const beginRecording = useCallback(() => {
    clearInterval(recording.countdownTimerRef.current);
    if (mediaRecorderRef.current) {
      // No timeslice — Chrome's MP4 MediaRecorder may produce empty fragments
      // with start(timeslice) on getDisplayMedia() streams. All data is buffered
      // internally and flushed as a single blob on stop().
      mediaRecorderRef.current.start();
    }
    if (webcamRecorderRef.current) {
      webcamRecorderRef.current.start(1000);
    }
    recording.startTimeRef.current = Date.now();
    recording.setState("recording");
    recording.startTimer();
  }, [recording]);

  const abortCountdown = useCallback(() => {
    recording.reset();
    stopCompositing();
    if (screenVideoRef.current) {
      screenVideoRef.current.srcObject = null;
    }
    stopAllStreams();
    mediaRecorderRef.current = null;
    webcamRecorderRef.current = null;
    webcamBlobPromiseRef.current = null;
  }, [recording, stopAllStreams, stopCompositing]);

  // Keep stable callback refs up to date
  stopRecordingRef.current = stopRecording;
  beginRecordingRef.current = beginRecording;

  async function toggleWebcam() {
    setMediaError(null);
    if (webcamEnabled) {
      // Fermer le PiP si actif
      if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
      }
      stopWebcamStream();
      setWebcamEnabled(false);
      return;
    }
    try {
      const videoConstraints: MediaTrackConstraints = { width: 320, height: 240 };
      if (devices.selectedCamera) {
        videoConstraints.deviceId = { exact: devices.selectedCamera };
      } else {
        videoConstraints.facingMode = "user";
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false,
      });
      webcamStreamRef.current = stream;

      // Créer un élément vidéo et lancer le Picture-in-Picture OS-level
      const pipVideo = document.createElement("video");
      pipVideo.srcObject = stream;
      pipVideo.muted = true;
      pipVideo.playsInline = true;
      pipVideo.autoplay = true;
      // Le video doit avoir une taille minimale pour que PiP fonctionne
      pipVideo.style.position = "fixed";
      pipVideo.style.bottom = "0";
      pipVideo.style.right = "0";
      pipVideo.style.width = "320px";
      pipVideo.style.height = "240px";
      pipVideo.style.opacity = "0.01";
      pipVideo.style.pointerEvents = "none";
      pipVideo.style.zIndex = "-1";
      document.body.appendChild(pipVideo);
      webcamPipVideoRef.current = pipVideo;

      await pipVideo.play();

      try {
        await pipVideo.requestPictureInPicture();
      } catch (pipErr) {
        console.warn("PiP not available, webcam stays in-page", pipErr);
        // PiP pas supporté — rendre le video visible en fallback
        pipVideo.style.opacity = "1";
        pipVideo.style.zIndex = "9999";
        pipVideo.style.borderRadius = "50%";
        pipVideo.style.objectFit = "cover";
        pipVideo.style.width = "160px";
        pipVideo.style.height = "160px";
        pipVideo.style.border = "3px solid rgba(255,255,255,0.3)";
        pipVideo.style.boxShadow = "0 4px 20px rgba(0,0,0,0.4)";
        pipVideo.style.pointerEvents = "auto";
      }

      setWebcamEnabled(true);
    } catch (err) {
      console.error("Webcam access failed", err);
      setMediaError("Could not access your camera. Please allow camera access and try again.");
    }
  }

  async function startRecording() {
    setMediaError(null);
    try {
      const displayMediaOptions: DisplayMediaStreamOptions & Record<string, unknown> = {
        video: true,
        audio: systemAudioEnabled,
      };
      if (systemAudioEnabled) {
        displayMediaOptions.systemAudio = "include";
        displayMediaOptions.suppressLocalAudioPlayback = true;
      }
      const screenStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
      screenStreamRef.current = screenStream;

      // Capture microphone audio separately — getDisplayMedia only provides
      // system/tab audio, never microphone input. MediaRecorder only records
      // one audio track, so we use AudioContext to mix system + mic audio
      // into a single track.
      let recordingStream: MediaStream = screenStream;
      if (systemAudioEnabled) {
        try {
          const micConstraints: MediaTrackConstraints = {};
          if (devices.selectedMicrophone) {
            micConstraints.deviceId = { exact: devices.selectedMicrophone };
          }
          const micStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints.deviceId ? micConstraints : true, video: false });
          micStreamRef.current = micStream;

          const audioContext = new AudioContext();
          audioContextRef.current = audioContext;
          const destination = audioContext.createMediaStreamDestination();

          // Connect system audio (if present) to the mixer
          if (screenStream.getAudioTracks().length > 0) {
            audioContext.createMediaStreamSource(screenStream).connect(destination);
          }

          // Connect microphone to the mixer
          audioContext.createMediaStreamSource(micStream).connect(destination);

          // Build recording stream: screen video + mixed audio
          recordingStream = new MediaStream([
            ...screenStream.getVideoTracks(),
            ...destination.stream.getAudioTracks(),
          ]);
        } catch (micErr) {
          console.warn("Microphone access denied, recording without mic audio", micErr);
        }
      }

      // Play screen stream on preview video first
      if (screenVideoRef.current) {
        screenVideoRef.current.srcObject = screenStream;
        await screenVideoRef.current.play();
      }

      // Get actual video frame dimensions (not constrained settings)
      const width = screenVideoRef.current?.videoWidth || 1920;
      const height = screenVideoRef.current?.videoHeight || 1080;
      setCaptureWidth(width);
      setCaptureHeight(height);

      // Set canvas dimensions to match actual video frames
      if (compositingCanvasRef.current) {
        compositingCanvasRef.current.width = width;
        compositingCanvasRef.current.height = height;
      }
      if (drawingCanvasRef.current) {
        drawingCanvasRef.current.width = width;
        drawingCanvasRef.current.height = height;
      }

      // Start compositing loop (for visual preview only)
      startCompositing();

      // Record the combined stream (screen video + system audio + mic audio)
      // directly — NOT through the canvas. Canvas compositing freezes when the
      // tab goes to the background because requestAnimationFrame/setInterval are
      // throttled. The raw streams keep capturing regardless of tab visibility.
      const mimeType = getSupportedMimeType();
      mimeTypeRef.current = mimeType;

      const recorder = new MediaRecorder(recordingStream, {
        mimeType,
      });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      recording.pauseStartRef.current = 0;
      recording.totalPausedRef.current = 0;

      // Webcam is captured as part of the screen recording (round circle on screen).
      // No separate webcam recording needed — avoids double overlay from server compositing.
      webcamBlobPromiseRef.current = null;
      webcamRecorderRef.current = null;
      webcamChunksRef.current = [];

      const handleDataAvailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      const handleStop = async () => {
        const blob = new Blob(chunksRef.current, { type: blobTypeFromMimeType(mimeTypeRef.current) });
        const elapsed = recording.elapsedSeconds();

        let webcamBlob: Blob | undefined;
        if (webcamBlobPromiseRef.current) {
          const timeout = new Promise<undefined>((resolve) => {
            setTimeout(() => {
              console.warn("Webcam blob promise timed out after 10s");
              resolve(undefined);
            }, 10_000);
          });
          webcamBlob = await Promise.race([webcamBlobPromiseRef.current, timeout]);
        }

        stopAllStreams();

        if (elapsed < MIN_RECORDING_SECONDS || blob.size < MIN_RECORDING_BYTES) {
          onRecordingError?.("Recording too short. Please record for at least 1 second.");
          return;
        }

        onRecordingComplete(blob, elapsed, webcamBlob);
      };

      // Track whether the encoder failed so the original onstop is skipped
      // when a fallback recorder takes over.
      let encoderFailed = false;

      recorder.ondataavailable = handleDataAvailable;

      recorder.onerror = () => {
        // Chrome's H.264 encoder fails for high-resolution display captures
        // (e.g., Retina screens exceeding encoder limits). Fall back to WebM.
        if (!mimeTypeRef.current.startsWith("video/mp4")) return;
        encoderFailed = true;

        const webmMimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
          ? "video/webm;codecs=vp9,opus"
          : "video/webm";
        mimeTypeRef.current = webmMimeType;
        chunksRef.current = [];

        const fallback = new MediaRecorder(recordingStream, { mimeType: webmMimeType });
        mediaRecorderRef.current = fallback;
        fallback.ondataavailable = handleDataAvailable;
        fallback.onstop = handleStop;
        fallback.start();
      };

      recorder.onstop = async () => {
        if (encoderFailed) return;
        await handleStop();
      };

      screenStream.getVideoTracks()[0].addEventListener("ended", () => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
          stopRecording();
        } else {
          abortCountdown();
        }
      });

      if (countdownEnabled.current) {
        recording.setCountdown(3);
        recording.setState("countdown");
      } else {
        beginRecording();
      }
    } catch (err) {
      console.error("Screen capture failed", err);
      setMediaError("Screen recording was blocked or failed. Please allow screen capture and try again.");
      stopAllStreams();
    }
  }

  const stopTimerRef = useRef(recording.stopTimer);
  stopTimerRef.current = recording.stopTimer;

  useEffect(() => {
    return () => {
      stopTimerRef.current();
      stopCompositing();
      stopAllStreams();
    };
  }, [stopAllStreams, stopCompositing]);

  useEffect(() => {
    if (previewExpanded) {
      document.documentElement.style.overflowX = "hidden";
      return () => { document.documentElement.style.overflowX = ""; };
    }
  }, [previewExpanded]);

  const { elapsed: duration, countdown: countdownValue,
    isIdle, isCountdown, isPaused, isActive, isRecording, remaining } = recording;

  return (
    <div className="recorder-container">
      {/* Screen preview with drawing overlay — hidden in idle, visible during recording */}
      <div style={{
        position: "relative",
        display: isActive ? "block" : "none",
        ...(previewExpanded
          ? { width: "100vw", maxWidth: "none" }
          : { width: "100%", maxWidth: 960 }),
      }}>
        <video
          ref={screenVideoRef}
          autoPlay
          muted
          playsInline
          data-testid="screen-preview"
          style={{
            width: "100%",
            borderRadius: previewExpanded ? 0 : 8,
            background: "#000",
            display: "block",
          }}
        />
        <canvas
          ref={drawingCanvasRef}
          data-testid="drawing-canvas"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            cursor: drawMode ? "crosshair" : "default",
            touchAction: "none",
            pointerEvents: drawMode ? "auto" : "none",
          }}
        />
        <button
          onClick={() => setPreviewExpanded((prev) => !prev)}
          aria-label={previewExpanded ? "Collapse preview" : "Expand preview"}
          data-testid="expand-preview"
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            zIndex: 10,
            width: 32,
            height: 32,
            borderRadius: 6,
            border: "none",
            background: "rgba(0, 0, 0, 0.6)",
            color: "#fff",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 16,
            padding: 0,
          }}
          title={previewExpanded ? "Collapse" : "Expand"}
        >
          {previewExpanded ? "\u2199" : "\u2197"}
        </button>
        {isCountdown && (
          <div
            className="countdown-overlay"
            data-testid="countdown-overlay"
            onClick={beginRecording}
          >
            <div className="countdown-number">{countdownValue}</div>
            <div className="countdown-hint">Click to start now</div>
          </div>
        )}
      </div>

      {/* Hidden compositing canvas — always mounted so ref is available */}
      <canvas
        ref={compositingCanvasRef}
        data-testid="compositing-canvas"
        style={{ display: "none" }}
      />

      {/* Idle UI */}
      {isIdle && (
        <>
          {mediaError && (
            <div
              role="alert"
              style={{
                background: "rgba(239, 68, 68, 0.1)",
                border: "1px solid var(--color-error)",
                borderRadius: 8,
                padding: "12px 16px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                width: "100%",
                maxWidth: 480,
              }}
            >
              <span style={{ color: "var(--color-error)", fontSize: 13 }}>{mediaError}</span>
              <button
                onClick={() => setMediaError(null)}
                aria-label="Dismiss error"
                style={{
                  background: "transparent",
                  color: "var(--color-error)",
                  border: "none",
                  fontSize: 16,
                  cursor: "pointer",
                  padding: "2px 6px",
                  lineHeight: 1,
                }}
              >
                &times;
              </button>
            </div>
          )}
          {maxDurationSeconds > 0 && (
            <p className="max-duration-label">
              Maximum recording length: {formatDuration(maxDurationSeconds)}
            </p>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%", maxWidth: 480 }}>
            {/* Device selectors */}
            {devices.cameras.length > 1 && (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <label style={{ fontSize: 13, color: "var(--color-text-secondary)", minWidth: 70 }}>Caméra</label>
                <select
                  value={devices.selectedCamera}
                  onChange={(e) => devices.setSelectedCamera(e.target.value)}
                  style={{
                    flex: 1, padding: "6px 8px", borderRadius: 6,
                    border: "1px solid var(--color-border)", background: "var(--color-surface)",
                    color: "var(--color-text)", fontSize: 13,
                  }}
                >
                  <option value="">Par défaut</option>
                  {devices.cameras.map((cam) => (
                    <option key={cam.deviceId} value={cam.deviceId}>{cam.label}</option>
                  ))}
                </select>
              </div>
            )}
            {devices.microphones.length > 1 && (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <label style={{ fontSize: 13, color: "var(--color-text-secondary)", minWidth: 70 }}>Micro</label>
                <select
                  value={devices.selectedMicrophone}
                  onChange={(e) => devices.setSelectedMicrophone(e.target.value)}
                  style={{
                    flex: 1, padding: "6px 8px", borderRadius: 6,
                    border: "1px solid var(--color-border)", background: "var(--color-surface)",
                    color: "var(--color-text)", fontSize: 13,
                  }}
                >
                  <option value="">Par défaut</option>
                  {devices.microphones.map((mic) => (
                    <option key={mic.deviceId} value={mic.deviceId}>{mic.label}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="record-controls">
              <button
                onClick={toggleWebcam}
                aria-label={webcamEnabled ? "Disable camera" : "Enable camera"}
                className={`btn-secondary${webcamEnabled ? " btn-secondary--active" : ""}`}
              >
                {webcamEnabled ? "Camera On" : "Camera Off"}
              </button>
              <button
                onClick={() => setSystemAudioEnabled((prev) => !prev)}
                aria-label={systemAudioEnabled ? "Disable system audio" : "Enable system audio"}
                className={`btn-secondary${systemAudioEnabled ? " btn-secondary--active" : ""}`}
              >
                {systemAudioEnabled ? "Audio On" : "Audio Off"}
              </button>
              <button
                onClick={async () => {
                  if (notesVisible && notesWindowRef.current) {
                    notesWindowRef.current.close();
                    notesWindowRef.current = null;
                    setNotesVisible(false);
                    return;
                  }

                  // Essayer Document PiP (fenêtre flottante OS-level)
                  // Fallback sur window.open si pas supporté
                  let win: Window | null = null;

                  if ("documentPictureInPicture" in window) {
                    try {
                      const pipWin = await (window as unknown as { documentPictureInPicture: { requestWindow: (opts: { width: number; height: number }) => Promise<Window> } }).documentPictureInPicture.requestWindow({ width: 350, height: 400 });
                      win = pipWin;
                    } catch {
                      // PiP refusé — fallback
                    }
                  }

                  if (!win) {
                    win = window.open("", "sendrec-notes", "width=350,height=400,left=50,top=100,resizable=yes");
                  }

                  if (win) {
                    const style = win.document.createElement("style");
                    style.textContent = `
                      * { margin: 0; padding: 0; box-sizing: border-box; }
                      body { background: #1a1a2e; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; flex-direction: column; height: 100vh; }
                      .header { padding: 10px 14px; font-size: 12px; font-weight: 600; color: rgba(255,255,255,0.5); border-bottom: 1px solid rgba(255,255,255,0.1); user-select: none; }
                      textarea { flex: 1; background: transparent; border: none; outline: none; color: #e2e8f0; font-size: 14px; line-height: 1.6; padding: 12px 14px; resize: none; width: 100%; }
                      textarea::placeholder { color: rgba(255,255,255,0.3); }
                    `;
                    win.document.head.appendChild(style);
                    win.document.body.innerHTML = `<div class="header">Notes (pas enregistrées)</div><textarea id="notes" placeholder="Écris tes notes ici..."></textarea>`;
                    const textarea = win.document.getElementById("notes") as HTMLTextAreaElement;
                    if (textarea) {
                      textarea.value = notesText;
                      textarea.addEventListener("input", () => setNotesText(textarea.value));
                    }
                    win.addEventListener("pagehide", () => {
                      notesWindowRef.current = null;
                      setNotesVisible(false);
                    });
                    notesWindowRef.current = win;
                    setNotesVisible(true);
                  }
                }}
                aria-label={notesVisible ? "Hide notes" : "Show notes"}
                className={`btn-secondary${notesVisible ? " btn-secondary--active" : ""}`}
              >
                {notesVisible ? "Notes On" : "Notes Off"}
              </button>
              <button
                onClick={startRecording}
                aria-label="Start recording"
                className="btn-record"
              >
                Start Recording
              </button>
            </div>
          </div>
        </>
      )}

      {/* Recording controls — always above preview */}
      {isRecording && (
        <div className="recording-header" role="status" aria-live="polite">
          <div className={`recording-indicator ${isPaused ? "recording-indicator--paused" : "recording-indicator--active"}`}>
            <div className={`recording-dot ${isPaused ? "recording-dot--paused" : "recording-dot--active"}`} />
            {formatDuration(duration)}
            {isPaused && <span className="recording-remaining">(Paused)</span>}
            {!isPaused && remaining !== null && (
              <span className="recording-remaining">({formatDuration(remaining)} remaining)</span>
            )}
          </div>

          <button
            onClick={toggleDrawMode}
            aria-label={drawMode ? "Disable drawing" : "Enable drawing"}
            data-testid="draw-toggle"
            className={`btn-draw${drawMode ? " btn-draw--active" : ""}`}
          >
            Draw
          </button>

          {drawMode && (
            <input
              type="color"
              value={drawColor}
              onChange={(e) => setDrawColor(e.target.value)}
              aria-label="Drawing color"
              data-testid="color-picker"
              style={{
                width: 36,
                height: 36,
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                padding: 2,
                background: "transparent",
                cursor: "pointer",
              }}
            />
          )}

          {drawMode && (
            <button
              onClick={clearCanvas}
              aria-label="Clear drawing"
              data-testid="clear-drawing"
              className="btn-pause"
            >
              Clear
            </button>
          )}

          {drawMode && (
            <div style={{ display: "flex", gap: 4, alignItems: "center" }} data-testid="thickness-selector">
              {[2, 4, 8].map((w) => (
                <button
                  key={w}
                  onClick={() => setLineWidth(w)}
                  aria-label={`Line width ${w}`}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    border: lineWidth === w ? "2px solid var(--color-accent)" : "1px solid var(--color-border)",
                    background: "transparent",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  <div
                    style={{
                      width: w + 2,
                      height: w + 2,
                      borderRadius: "50%",
                      background: "var(--color-text)",
                    }}
                  />
                </button>
              ))}
            </div>
          )}

          {isPaused ? (
            <button onClick={resumeRecording} aria-label="Resume recording" className="btn-resume">
              Resume
            </button>
          ) : (
            <button onClick={pauseRecording} aria-label="Pause recording" className="btn-pause">
              Pause
            </button>
          )}

          <button onClick={stopRecording} aria-label="Stop recording" className="btn-stop">
            Stop Recording
          </button>
        </div>
      )}

      {/* Webcam en Picture-in-Picture natif — flotte au-dessus de toutes les apps macOS */}

      {/* Notes dans une fenêtre popup séparée — jamais capturées par l'enregistrement écran */}
    </div>
  );
}
