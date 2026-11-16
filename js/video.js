// Turn a screen recording into timestamped JPEG frames, on the phone.
export const MAX_FRAMES = 90;   // Claude accepts up to 100 images per request; leave headroom.
const FRAME_HEIGHT = 800;       // keeps every frame well under the many-image size limit.

const once = (target, event) =>
  new Promise((resolve, reject) => {
    target.addEventListener(event, resolve, { once: true });
    target.addEventListener("error", () => reject(new Error("This video couldn't be read on this phone.")), { once: true });
  });

// Returns [{ t: seconds, data: base64 jpeg }], evenly spaced across the recording.
export async function extractFrames(file, onProgress) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = URL.createObjectURL(file);
  await once(video, "loadeddata");

  const interval = Math.max(1, video.duration / MAX_FRAMES);
  const count = Math.min(MAX_FRAMES, Math.floor(video.duration / interval));
  if (!count) throw new Error("The recording is too short to analyze.");
  const canvas = document.createElement("canvas");
  canvas.height = FRAME_HEIGHT;
  canvas.width = Math.round((video.videoWidth / video.videoHeight) * FRAME_HEIGHT);
  const context = canvas.getContext("2d");

  const frames = [];
  for (let i = 0; i < count; i++) {
    video.currentTime = i * interval + 0.05;
    await once(video, "seeked");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    frames.push({ t: i * interval, data: canvas.toDataURL("image/jpeg", 0.6).split(",")[1] });
    onProgress((i + 1) / count);
  }
  URL.revokeObjectURL(video.src);
  return frames;
}
