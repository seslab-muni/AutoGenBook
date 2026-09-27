"""Text-to-speech providers behind one protocol.

`openrouter` (default): the OpenAI-compatible `/audio/speech` endpoint of the
TTS base URL (OpenRouter unless `AUTOGENBOOK_TTS_BASE_URL` says otherwise),
MP3 output, requested outside the LLM concurrency limiter. `local`: Coqui TTS
(XTTS v2 with a speaker reference, otherwise a per-language VITS model), an
optional extra (`pip install .[tts-local]`) imported only when used; the
model runs in a worker thread, one clip at a time. Durations are measured
without ffmpeg (`engine.media.audio`).
"""

from __future__ import annotations

import asyncio
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from engine.errors import EngineError
from engine.media.audio import join_mp3, join_wav, mp3_duration, wav_duration

DEFAULT_VOICE = "alloy"
OPENROUTER_MAX_CHARS = 3500  # the endpoint accepts 4096 characters per request
XTTS_MODEL = "tts_models/multilingual/multi-dataset/xtts_v2"
VITS_MODELS = {
    "cs": "tts_models/cs/cv/vits",
    "sk": "tts_models/sk/cv/vits",
    "en": "tts_models/en/ljspeech/vits",
    "de": "tts_models/de/thorsten/vits",
    "pl": "tts_models/pl/mai_female/vits",
    "fr": "tts_models/fr/css10/vits",
    "es": "tts_models/es/css10/vits",
    "nl": "tts_models/nl/css10/vits",
    "hu": "tts_models/hu/css10/vits",
}
XTTS_LANGUAGES = {"en", "es", "fr", "de", "it", "pt", "pl", "tr", "ru", "nl", "cs", "ar", "zh", "ja", "hu", "ko"}


class TTSError(EngineError):
    pass


@dataclass
class Clip:
    path: Path
    seconds: float


@runtime_checkable
class TTSProvider(Protocol):
    name: str
    extension: str  # file extension of the clips it writes ("mp3" or "wav")

    async def synthesize(self, text: str, out_path: Path, *, node_key: str | None = None) -> Clip: ...

    def join(self, clips: list[Clip], out_path: Path) -> Path: ...


def chunk_text(text: str, max_len: int) -> list[str]:
    """Sentence-aligned chunks of at most `max_len` characters (long
    sentences split at clause punctuation, then at words)."""
    text = re.sub(r"\s+", " ", text or "").strip()
    if not text:
        return []
    pieces: list[str] = []
    for sentence in re.split(r"(?<=[.?!…])\s+", text):
        if len(sentence) <= max_len:
            pieces.append(sentence)
            continue
        for clause in re.split(r"(?<=[,;:])\s+", sentence):
            while len(clause) > max_len:
                cut = clause.rfind(" ", 0, max_len)
                cut = cut if cut > 0 else max_len
                pieces.append(clause[:cut].strip())
                clause = clause[cut:].strip()
            if clause:
                pieces.append(clause)
    chunks: list[str] = []
    for piece in pieces:
        if chunks and len(chunks[-1]) + 1 + len(piece) <= max_len:
            chunks[-1] = f"{chunks[-1]} {piece}"
        else:
            chunks.append(piece)
    return chunks


class OpenRouterTTS:
    name = "openrouter"
    extension = "mp3"

    def __init__(self, llm: Any, *, base_url: str, api_key: str | None, model: str, voice: str = DEFAULT_VOICE) -> None:
        self.llm = llm
        self.url = base_url.rstrip("/") + "/audio/speech"
        self.api_key = api_key
        self.model = model
        self.voice = voice or DEFAULT_VOICE

    async def synthesize(self, text: str, out_path: Path, *, node_key: str | None = None) -> Clip:
        parts = chunk_text(text, OPENROUTER_MAX_CHARS)
        if not parts:
            raise TTSError("nothing to synthesize")
        clips: list[bytes] = []
        for part in parts:
            payload = {"model": self.model, "input": part, "voice": self.voice, "response_format": "mp3"}
            data = await self.llm.post_bytes(
                self.url, payload, label="presentation.tts", kind="tts", model=self.model, api_key=self.api_key,
                node_key=node_key, limited=False, timeout=180,
            )
            if mp3_duration(data) <= 0:
                raise TTSError(f"the TTS endpoint returned no MP3 audio ({len(data)} bytes)")
            clips.append(data)
        audio = clips[0] if len(clips) == 1 else join_mp3(clips)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(audio)
        return Clip(out_path, mp3_duration(audio))

    def join(self, clips: list[Clip], out_path: Path) -> Path:
        out_path.write_bytes(join_mp3([c.path.read_bytes() for c in clips]))
        return out_path


class LocalCoquiTTS:
    """Coqui TTS in-process. The model is loaded lazily on first use and kept
    on this instance (no module-level state); synthesis is serialised because
    the model is not thread-safe."""

    name = "local"
    extension = "wav"

    def __init__(self, *, language: str, speaker_wavs: list[Path] | None = None, model_name: str | None = None) -> None:
        self.language = language
        self.speaker_wavs = [p for p in (speaker_wavs or []) if p.is_file()]
        self.model_name = model_name
        self._model: Any = None
        self._lock = asyncio.Lock()

    def _choose_model(self) -> tuple[str, bool]:
        if self.model_name:
            return self.model_name, "xtts" in self.model_name
        if self.speaker_wavs and self.language in XTTS_LANGUAGES:
            return XTTS_MODEL, True
        if self.language in VITS_MODELS:
            return VITS_MODELS[self.language], False
        raise TTSError(
            f"local TTS: no single-speaker model for language '{self.language}'; "
            "set AUTOGENBOOK_TTS_SPEAKER_WAV to a reference recording to use XTTS v2"
        )

    def _load(self) -> tuple[Any, bool]:
        name, is_xtts = self._choose_model()
        if self._model is None:
            try:
                from TTS.api import TTS  # type: ignore[import-not-found]
            except ImportError as exc:
                raise TTSError("local TTS needs the optional Coqui dependency: pip install '.[tts-local]'") from exc
            self._model = TTS(model_name=name, progress_bar=False, gpu=False)
        return self._model, is_xtts

    def _synthesize_blocking(self, text: str, out_path: Path) -> Clip:
        model, is_xtts = self._load()
        parts = chunk_text(text, 400 if is_xtts else 800)
        if not parts:
            raise TTSError("nothing to synthesize")
        with tempfile.TemporaryDirectory(prefix="engine_tts_") as tmp:
            pieces: list[Path] = []
            for index, part in enumerate(parts):
                piece = Path(tmp) / f"part_{index:03d}.wav"
                kwargs: dict[str, Any] = {"text": part, "file_path": str(piece)}
                if is_xtts:
                    kwargs.update(speaker_wav=[str(p) for p in self.speaker_wavs], language=self.language)
                elif getattr(model, "speakers", None):
                    kwargs["speaker"] = model.speakers[0]
                model.tts_to_file(**kwargs)
                pieces.append(piece)
            join_wav(pieces, out_path, gap_s=0.15)
        return Clip(out_path, wav_duration(out_path))

    async def synthesize(self, text: str, out_path: Path, *, node_key: str | None = None) -> Clip:
        async with self._lock:
            return await asyncio.to_thread(self._synthesize_blocking, text, out_path)

    def join(self, clips: list[Clip], out_path: Path) -> Path:
        return join_wav([c.path for c in clips], out_path, gap_s=0.5)


def make_provider(settings: Any, *, llm: Any, language: str, api_key: str | None, speaker_wavs: list[Path]) -> TTSProvider:
    """The provider `--presentation-tts-mode` selects."""
    if settings.tts_mode == "local":
        return LocalCoquiTTS(language=language, speaker_wavs=speaker_wavs, model_name=settings.tts_local_model)
    return OpenRouterTTS(llm, base_url=settings.tts_base_url, api_key=api_key, model=settings.tts_model, voice=settings.tts_voice)
