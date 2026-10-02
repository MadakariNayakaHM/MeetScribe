"""Transcribe a meeting recording with faster-whisper (runs fully locally).

Invoked by the Node server as a subprocess. Emits newline-delimited JSON on stdout:
  {"type": "info", "duration": 123.4, "channels": 2}
  {"type": "progress", "value": 0.42}
  {"type": "result", "language": "en", "segments": [{startMs, endMs, text, speaker}, ...]}
Errors go to stderr with a non-zero exit code.

With --stereo-tracks the input is a stereo file whose left channel is the local
microphone and right channel is the shared tab (other participants). Each channel is
transcribed separately and labelled, which gives "me vs others" speakers for free.
"""

import argparse
import json
import re
import sys
from difflib import SequenceMatcher

import numpy as np
from faster_whisper import WhisperModel, decode_audio
from faster_whisper.vad import VadOptions, get_speech_timestamps

SAMPLE_RATE = 16000
SILENT_RMS = 0.002  # channels quieter than this are skipped (e.g. tab never played audio)
PAUSE_SPLIT_S = 0.8  # start a new line after a pause this long
MAX_LINE_WORDS = 40
CLIP_MERGE_GAP_S = 1.5  # speech regions closer than this are transcribed as one clip
CLIP_MAX_S = 30.0


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def normalize(text):
    return re.sub(r"[^\w\s]", "", text.lower()).split()


def similar(a, b):
    wa, wb = normalize(a), normalize(b)
    if not wa or not wb:
        return 0.0
    return SequenceMatcher(None, wa, wb).ratio()


def speech_clips(audio):
    """Find speech with Silero VAD and return [start, end, start, end, ...] in seconds.

    We pass these to Whisper as clip_timestamps rather than using vad_filter=True: the
    built-in filter concatenates speech and remaps times afterwards, which can attach words
    to the wrong side of a long silence. Clips keep timestamps in real audio time."""
    regions = get_speech_timestamps(audio, VadOptions(min_silence_duration_ms=500, speech_pad_ms=300))
    clips = []
    for r in regions:
        start, end = r["start"] / SAMPLE_RATE, r["end"] / SAMPLE_RATE
        if clips and start - clips[-1][1] <= CLIP_MERGE_GAP_S and end - clips[-1][0] <= CLIP_MAX_S:
            clips[-1][1] = end
        else:
            clips.append([start, end])
    return [t for clip in clips for t in clip]


def to_lines(segments, speaker, on_progress):
    """Re-split whisper segments into lines using word timings, so each line's timestamps
    hug the actual speech and long pauses (or a change of turn) start a new line."""
    lines, words = [], []

    def flush():
        if words:
            text = "".join(w.word for w in words).strip()
            if text:
                lines.append({
                    "startMs": round(words[0].start * 1000),
                    "endMs": round(words[-1].end * 1000),
                    "text": text,
                    "speaker": speaker,
                })
            words.clear()

    for seg in segments:
        for w in seg.words or []:
            if words:
                gap = w.start - words[-1].end
                sentence_end = words[-1].word.rstrip().endswith((".", "?", "!"))
                if gap >= PAUSE_SPLIT_S or (sentence_end and gap >= 0.3) or len(words) >= MAX_LINE_WORDS:
                    flush()
            words.append(w)
        on_progress(seg.end)
    flush()
    return lines


def drop_echo(mic_segments, tab_segments):
    """Remove mic segments that are just the other participants leaking from the speakers."""
    kept = []
    for seg in mic_segments:
        echo = False
        for other in tab_segments:
            overlap = min(seg["endMs"], other["endMs"]) - max(seg["startMs"], other["startMs"])
            if overlap > 0 and similar(seg["text"], other["text"]) >= 0.6:
                echo = True
                break
        if not echo:
            kept.append(seg)
    return kept


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--stereo-tracks", action="store_true")
    p.add_argument("--labels", default="Speaker 1,Others", help="comma-separated speaker labels per channel")
    p.add_argument("--language", default=None, help="ISO 639-1 code, omit to auto-detect")
    p.add_argument("--model", default="small")
    p.add_argument("--device", default="auto")
    p.add_argument("--compute-type", default="int8")
    p.add_argument("--threads", type=int, default=0)
    p.add_argument("--model-dir", default=None)
    args = p.parse_args()

    labels = [s.strip() or f"Speaker {i + 1}" for i, s in enumerate(args.labels.split(","))]

    if args.stereo_tracks:
        left, right = decode_audio(args.input, sampling_rate=SAMPLE_RATE, split_stereo=True)
        channels = [(left, labels[0]), (right, labels[1] if len(labels) > 1 else "Others")]
    else:
        channels = [(decode_audio(args.input, sampling_rate=SAMPLE_RATE), labels[0])]

    duration = max(len(a) for a, _ in channels) / SAMPLE_RATE
    channels = [(a, label) for a, label in channels if len(a) and float(np.sqrt(np.mean(a**2))) > SILENT_RMS]
    emit({"type": "info", "duration": duration, "channels": len(channels)})

    model = WhisperModel(
        args.model,
        device=args.device,
        compute_type=args.compute_type,
        cpu_threads=args.threads,
        download_root=args.model_dir,
    )

    total = sum(len(a) for a, _ in channels) / SAMPLE_RATE or 1.0
    done = 0.0
    language = args.language
    per_channel = []
    for audio, label in channels:
        clips = speech_clips(audio)
        if not clips:
            done += len(audio) / SAMPLE_RATE
            per_channel.append([])
            continue
        segments, info = model.transcribe(
            audio,
            language=language,
            beam_size=5,
            clip_timestamps=clips,
            condition_on_previous_text=False,  # avoids repetition loops on long audio
            word_timestamps=True,
        )
        language = language or info.language  # reuse detected language for the next channel
        out = to_lines(segments, label, lambda t: emit({"type": "progress", "value": min(0.99, (done + t) / total)}))
        done += len(audio) / SAMPLE_RATE
        per_channel.append(out)

    if len(per_channel) == 2:
        per_channel[0] = drop_echo(per_channel[0], per_channel[1])

    merged = sorted((s for ch in per_channel for s in ch), key=lambda s: s["startMs"])
    emit({"type": "result", "language": language, "segments": merged})


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # surface a clean message to the Node side
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
