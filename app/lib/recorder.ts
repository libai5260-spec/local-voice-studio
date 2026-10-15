import { SAMPLE_RATE } from "./audio";

export type ActiveRecorder = {
  start: () => void;
  stop: () => Promise<Float32Array>;
  cancel: () => void;
};

export async function createRecorder(): Promise<ActiveRecorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  const mimeType = preferredMimeType();
  const mediaRecorder = mimeType
    ? new MediaRecorder(stream, { mimeType })
    : new MediaRecorder(stream);
  const chunks: Blob[] = [];
  mediaRecorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) chunks.push(event.data);
  });

  const stopTracks = () => stream.getTracks().forEach((track) => track.stop());

  return {
    start() {
      mediaRecorder.start(250);
    },
    stop() {
      return new Promise<Float32Array>((resolve, reject) => {
        mediaRecorder.addEventListener("stop", async () => {
          stopTracks();
          try {
            const blob = new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" });
            resolve(await blobToFloat32(blob));
          } catch (error) {
            reject(error);
          }
        }, { once: true });
        mediaRecorder.addEventListener("error", () => {
          stopTracks();
          reject(new Error("Recording failed. Please try again."));
        }, { once: true });
        mediaRecorder.stop();
      });
    },
    cancel() {
      stopTracks();
      if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
    },
  };
}

export async function audioFileToFloat32(file: File) {
  return blobToFloat32(file);
}

async function blobToFloat32(blob: Blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(arrayBuffer.slice(0));
    return await resampleMono(decoded);
  } finally {
    await context.close();
  }
}

async function resampleMono(audioBuffer: AudioBuffer) {
  const sampleCount = Math.max(1, Math.round(audioBuffer.duration * SAMPLE_RATE));
  const context = new OfflineAudioContext(1, sampleCount, SAMPLE_RATE);
  const source = context.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(context.destination);
  source.start();
  const rendered = await context.startRendering();
  return rendered.getChannelData(0).slice();
}

function preferredMimeType() {
  const choices = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"];
  return choices.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
}
