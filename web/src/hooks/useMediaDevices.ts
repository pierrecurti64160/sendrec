import { useEffect, useState, useCallback } from "react";

interface MediaDeviceOption {
  deviceId: string;
  label: string;
}

interface MediaDevices {
  cameras: MediaDeviceOption[];
  microphones: MediaDeviceOption[];
  selectedCamera: string;
  selectedMicrophone: string;
  setSelectedCamera: (id: string) => void;
  setSelectedMicrophone: (id: string) => void;
  refreshDevices: () => Promise<void>;
}

export function useMediaDevices(): MediaDevices {
  const [cameras, setCameras] = useState<MediaDeviceOption[]>([]);
  const [microphones, setMicrophones] = useState<MediaDeviceOption[]>([]);
  const [selectedCamera, setSelectedCamera] = useState(
    () => localStorage.getItem("sendrec-camera") || ""
  );
  const [selectedMicrophone, setSelectedMicrophone] = useState(
    () => localStorage.getItem("sendrec-microphone") || ""
  );

  const refreshDevices = useCallback(async () => {
    try {
      // Request permission first so labels are populated
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      // Permission denied — enumerateDevices will still work but labels may be empty
    }

    const devices = await navigator.mediaDevices.enumerateDevices();

    const cams = devices
      .filter((d) => d.kind === "videoinput")
      .map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `Camera ${i + 1}`,
      }));

    const mics = devices
      .filter((d) => d.kind === "audioinput")
      .map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `Microphone ${i + 1}`,
      }));

    setCameras(cams);
    setMicrophones(mics);
  }, []);

  useEffect(() => {
    refreshDevices();

    navigator.mediaDevices.addEventListener("devicechange", refreshDevices);
    return () => {
      navigator.mediaDevices.removeEventListener("devicechange", refreshDevices);
    };
  }, [refreshDevices]);

  const selectCamera = useCallback((id: string) => {
    setSelectedCamera(id);
    localStorage.setItem("sendrec-camera", id);
  }, []);

  const selectMicrophone = useCallback((id: string) => {
    setSelectedMicrophone(id);
    localStorage.setItem("sendrec-microphone", id);
  }, []);

  return {
    cameras,
    microphones,
    selectedCamera,
    selectedMicrophone,
    setSelectedCamera: selectCamera,
    setSelectedMicrophone: selectMicrophone,
    refreshDevices,
  };
}
