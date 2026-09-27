"""Audio helpers without ffmpeg: MP3 frame parsing (duration, joining), WAV
duration/joining with the standard library, SRT subtitles.

The old engine decoded every clip with pydub (ffmpeg) only to measure and
concatenate it. MP3 streams concatenate frame by frame, and WAV clips from
one TTS model share their format, so neither needs a decoder.
"""

from __future__ import annotations

import wave
from pathlib import Path
from typing import Iterable, Sequence

# MPEG audio frame header tables (version index: 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5).
_BITRATES = {
    (3, 1): [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    (3, 2): [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    (3, 3): [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    (2, 1): [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    (2, 2): [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}
_BITRATES[(2, 3)] = _BITRATES[(2, 2)]
for _layer in (1, 2, 3):
    _BITRATES[(0, _layer)] = _BITRATES[(2, _layer)]
_SAMPLE_RATES = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]}
_LAYER = {3: 1, 2: 2, 1: 3}  # header bits -> layer number


def _id3_size(data: bytes) -> int:
    if len(data) >= 10 and data[:3] == b"ID3":
        size = (data[6] & 0x7F) << 21 | (data[7] & 0x7F) << 14 | (data[8] & 0x7F) << 7 | (data[9] & 0x7F)
        return 10 + size + (10 if data[5] & 0x10 else 0)
    return 0


def _frames(data: bytes) -> Iterable[tuple[int, int, float]]:
    """(offset, length, seconds) of each MPEG audio frame."""
    pos = _id3_size(data)
    end = len(data)
    if end >= 128 and data[-128:-125] == b"TAG":
        end -= 128
    first = True
    while pos + 4 <= end:
        b1, b2, b3 = data[pos + 1], data[pos + 2], data[pos + 3]
        if data[pos] != 0xFF or (b1 & 0xE0) != 0xE0:
            pos += 1
            continue
        version = (b1 >> 3) & 0x03
        layer = _LAYER.get((b1 >> 1) & 0x03)
        bitrate_index = (b2 >> 4) & 0x0F
        rate_index = (b2 >> 2) & 0x03
        if version == 1 or layer is None or bitrate_index in (0, 15) or rate_index == 3:
            pos += 1
            continue
        bitrate = _BITRATES[(version, layer)][bitrate_index] * 1000
        sample_rate = _SAMPLE_RATES[version][rate_index]
        padding = (b2 >> 1) & 0x01
        if layer == 1:
            samples = 384
            length = (12 * bitrate // sample_rate + padding) * 4
        else:
            samples = 1152 if (layer == 2 or version == 3) else 576
            length = samples // 8 * bitrate // sample_rate + padding
        if length < 4:
            pos += 1
            continue
        if first:
            first = False
            # A LAME/Xing "Info"/"Xing" or Fraunhofer "VBRI" header frame carries
            # stream metadata, not audio: skip it (joined clips must not repeat it).
            mono = (b3 >> 6) == 3
            side_info = (17 if mono else 32) if version == 3 else (9 if mono else 17)
            tag = data[pos + 4 + side_info : pos + 8 + side_info]
            if tag in (b"Xing", b"Info") or data[pos + 36 : pos + 40] == b"VBRI":
                pos += length
                continue
        yield pos, length, samples / sample_rate
        pos += length


def mp3_duration(data: bytes) -> float:
    return round(sum(seconds for _pos, _len, seconds in _frames(data)), 3)


def mp3_frames_only(data: bytes) -> bytes:
    """The audio frames without ID3 tags or a Xing/Info/VBRI header frame
    (safe to concatenate)."""
    return b"".join(data[pos : pos + length] for pos, length, _s in _frames(data))


def join_mp3(clips: Sequence[bytes]) -> bytes:
    return b"".join(mp3_frames_only(clip) for clip in clips)


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as handle:
        rate = handle.getframerate() or 1
        return round(handle.getnframes() / rate, 3)


def join_wav(paths: Sequence[Path], out_path: Path, *, gap_s: float = 0.0) -> Path:
    """Concatenate WAV files that share one format (as clips from one TTS model
    do), optionally with silence between them."""
    params = None
    frames: list[bytes] = []
    for path in paths:
        with wave.open(str(path), "rb") as handle:
            current = handle.getparams()
            if params is None:
                params = current
            elif (current.nchannels, current.sampwidth, current.framerate) != (params.nchannels, params.sampwidth, params.framerate):
                raise ValueError(f"{path.name}: WAV format differs from the first clip")
            frames.append(handle.readframes(handle.getnframes()))
    if params is None:
        raise ValueError("no WAV clips to join")
    silence = b"\x00" * int(params.framerate * gap_s) * params.nchannels * params.sampwidth
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(out_path), "wb") as out:
        out.setnchannels(params.nchannels)
        out.setsampwidth(params.sampwidth)
        out.setframerate(params.framerate)
        out.writeframes(silence.join(frames))
    return out_path


def srt_timestamp(seconds: float) -> str:
    millis = int(round(max(0.0, seconds) * 1000))
    hours, rest = divmod(millis, 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    secs, millis = divmod(rest, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def srt(entries: Sequence[tuple[str, float]]) -> str:
    """Subtitles for consecutive clips: (text, duration seconds) in order."""
    out: list[str] = []
    start = 0.0
    for number, (text, duration) in enumerate(entries, start=1):
        end = start + max(0.0, duration)
        out.append(f"{number}\n{srt_timestamp(start)} --> {srt_timestamp(end)}\n{' '.join(text.split())}\n")
        start = end
    return "\n".join(out)


def silent_mp3(seconds: float) -> bytes:
    """A valid MPEG-1 Layer III stream of silence-sized frames (128 kbit/s,
    44.1 kHz): used by the tests' fake TTS endpoint and the smoke tools."""
    frame = bytes([0xFF, 0xFB, 0x90, 0x00]) + bytes(413)
    count = max(1, int(round(seconds * 44100 / 1152)))
    return frame * count
