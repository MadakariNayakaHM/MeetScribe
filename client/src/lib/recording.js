// Browser plumbing for a recording session: audio capture/mixing, MediaRecorder and
// live speech recognition (Web Speech API). UI-agnostic; the Recorder page drives it.

export const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

export const pickMimeType = () =>
  MIME_CANDIDATES.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';

export const extensionFor = (mime) =>
  mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'audio';

/**
 * Capture the microphone and (optionally) a shared tab/screen's audio, mixed into one stream.
 * The AudioContext must be created synchronously inside the click handler, before any await.
 */
export async function captureAudio(ctx, { includeTabAudio, onTabAudioEnded }) {
  const streams = [];
  const stopAll = () => streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  try {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    streams.push(mic);

    const dest = ctx.createMediaStreamDestination();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const micNode = ctx.createMediaStreamSource(mic);
    micNode.connect(dest);
    micNode.connect(analyser);

    let tabAudio = false;
    let tracksStream = null;
    if (includeTabAudio) {
      // Chrome only offers audio together with video; we ignore the video track.
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      streams.push(display);
      const [track] = display.getAudioTracks();
      if (track) {
        tabAudio = true;
        track.addEventListener('ended', onTabAudioEnded);
        const tabNode = ctx.createMediaStreamSource(new MediaStream([track]));
        tabNode.connect(dest);
        tabNode.connect(analyser);

        // Second recording with mic on the left channel and tab audio on the right, so the
        // server can transcribe "me" and "others" separately.
        const merger = ctx.createChannelMerger(2);
        micNode.connect(merger, 0, 0);
        tabNode.connect(merger, 0, 1);
        const tracksDest = ctx.createMediaStreamDestination();
        tracksDest.channelCount = 2;
        merger.connect(tracksDest);
        tracksStream = tracksDest.stream;
      }
    }
    return { stream: dest.stream, tracksStream, analyser, tabAudio, stop: stopAll };
  } catch (err) {
    stopAll();
    throw err;
  }
}

/** Record a stream into chunks; stop() resolves with the final Blob. */
export function startRecorder(stream, bitsPerSecond) {
  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, { ...(mimeType && { mimeType }), audioBitsPerSecond: bitsPerSecond });
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.start(1000);
  return {
    pause: () => recorder.state === 'recording' && recorder.pause(),
    resume: () => recorder.state === 'paused' && recorder.resume(),
    stop: () =>
      new Promise((resolve) => {
        if (recorder.state === 'inactive') return resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
        recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
        recorder.stop();
      }),
  };
}

export function describeMediaError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
      return 'Permission denied. Allow microphone (and screen sharing, if selected) access in your browser and try again.';
    case 'NotFoundError':
      return 'No microphone was found. Connect one and try again.';
    case 'NotReadableError':
      return 'Your microphone is being used by another application.';
    default:
      return err?.message || 'Could not start recording.';
  }
}

/**
 * Continuous speech recognition that survives Chrome's habit of ending sessions after
 * silence or ~60s. Calls onFinal(text) for each finalized phrase and onInterim(text) as
 * the current phrase evolves.
 */
export function createTranscriber({ lang, onFinal, onInterim, onError }) {
  if (!SpeechRecognition) return null;

  let wanted = false;
  let running = false;
  let fatal = false;
  let failures = 0;
  let restartTimer;
  let endResolvers = [];

  const rec = new SpeechRecognition();
  rec.lang = lang;
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  rec.onstart = () => { running = true; };

  rec.onresult = (e) => {
    failures = 0;
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      const text = result[0].transcript.trim();
      if (result.isFinal) {
        if (text) onFinal(text);
      } else {
        interim += `${result[0].transcript} `;
      }
    }
    onInterim(interim.trim());
  };

  rec.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    if (['not-allowed', 'service-not-allowed', 'language-not-supported'].includes(e.error)) {
      fatal = true;
      onError(
        e.error === 'language-not-supported'
          ? `Live transcription doesn't support "${lang}". Audio is still being recorded.`
          : 'Live transcription was blocked by the browser. Audio is still being recorded.',
        true,
      );
      return;
    }
    failures += 1;
    onError(
      e.error === 'network'
        ? 'Speech service unreachable (it needs an internet connection). Retrying…'
        : `Speech recognition error: ${e.error}. Retrying…`,
      false,
    );
  };

  rec.onend = () => {
    running = false;
    onInterim('');
    endResolvers.forEach((r) => r());
    endResolvers = [];
    if (wanted && !fatal) {
      const delay = Math.min(10000, 250 * 2 ** Math.min(failures, 6));
      restartTimer = setTimeout(() => {
        if (!wanted) return;
        try { rec.start(); } catch { /* already started */ }
      }, delay);
    }
  };

  return {
    start() {
      wanted = true;
      try { rec.start(); } catch { /* already started */ }
    },
    /** Stops listening; resolves once pending final results have been delivered. */
    stop() {
      wanted = false;
      clearTimeout(restartTimer);
      return new Promise((resolve) => {
        try { rec.stop(); } catch { /* not started */ }
        if (!running) return resolve();
        endResolvers.push(resolve);
        setTimeout(resolve, 2000);
      });
    },
  };
}
