"""Presentation building blocks (#156): the spec parser, deck Markdown, PPTX
lines, audio helpers, TTS chunking and the TTS request path (outside the LLM
limiter). Media steps are mocked: no audio model, no ffmpeg."""

from __future__ import annotations

import asyncio
import wave
from pathlib import Path

import pytest

from engine.assemble.deck import DeckSettings, build_deck, front_matter, limit_lines, pptx_lines, slide_body, split_frames
from engine.config import LLMSettings
from engine.events import MemorySink
from engine.llm.client import LLMClient
from engine.llm.usage import UsageLedger
from engine.media.audio import join_mp3, join_wav, mp3_duration, silent_mp3, srt, srt_timestamp, wav_duration
from engine.media.tts import OpenRouterTTS, chunk_text
from engine.spec.presentation import normalize_presentation_structure, parse_presentation_txt, parse_slide_ranges
from fake_llm import FakeLLM


def test_spec_labels_and_explicit_slides() -> None:
    spec = parse_presentation_txt(
        "Title: Early computers\nAudience: students\nDuration: 20 min\nSlides: 8\nStyle: visual\n"
        "Author: Ada\nMust include: the EDVAC report\n\n"
        "Slide 1: Introduction\nText on slide:\n• Early computers\n• Why they matter\n\n"
        "Slide 2: Babbage\n- Difference Engine\n  - finite differences\n"
    )
    assert (spec.title, spec.audience, spec.duration_minutes, spec.slide_count, spec.author) == ("Early computers", "students", 20.0, 8, "Ada")
    assert spec.additional_requirements == "Must include: the EDVAC report"
    assert [s.title for s in spec.slides] == ["Introduction", "Babbage"]
    assert spec.slides[1].bullets == ["Difference Engine", "finite differences"] and spec.target_slides() == 8
    assert parse_presentation_txt("Title: X\nDuration: 15 minutes").target_slides() == 10  # ~1.5 min per slide
    assert parse_presentation_txt("Title: X").target_slides() == 10


def test_structure_json_keeps_old_keys() -> None:
    deck = normalize_presentation_structure({
        "title": "T", "theme": "beamer", "max_output_pages": 1.0,
        "slides": [{"title": "A", "n_pages": 1}, {"title": "B", "n_pages": 3}, "junk"],
    })
    assert deck.theme == "Madrid" and deck.outline is True and deck.paginate is False
    assert [(s.title, s.needsSubdivision) for s in deck.slides] == [("A", False), ("B", True)] and deck.n_pages == 4


def test_slide_ranges() -> None:
    assert parse_slide_ranges("2, 5,10-12, x, 7-6") == {2, 5, 6, 7, 10, 11, 12}
    assert parse_slide_ranges("") == set()


def test_deck_markdown_round_trip() -> None:
    settings = DeckSettings(title="Talk", summary="About things.", author="Ada", header="MUNI")
    deck = build_deck(settings, [("One", "## Sub\n- a\n---\n- b ![x](y.png)"), ("Two", "")])
    assert front_matter(deck) == {"theme": "Madrid", "paginate": "false", "outline": "true", "author": "Ada", "header": "MUNI"}
    frames = split_frames(deck)
    assert [(f.index, f.title, f.is_title) for f in frames] == [(1, "Talk", True), (2, "One", False), (3, "Two", False)]
    assert frames[1].body == "**Sub**\n\n- a\n- b" and frames[0].body == "About things.\n\n**Ada**"
    assert slide_body("# H\ntext") == "**H**\n\ntext"
    body, dropped = limit_lines("\n".join(f"- {i}" for i in range(14)), 10)
    assert dropped == 4 and body.count("\n") == 9


def test_pptx_lines() -> None:
    lines = pptx_lines("- **Bold** point [1]\n  - nested `code`\n1. first\n| a | b |\n|---|---|\n| 1 | 2 |\nplain *em*")
    assert lines == [("• Bold point [1]", 0), ("• nested code", 1), ("1. first", 0), ("a | b", 0), ("1 | 2", 0), ("plain em", 0)]


def test_mp3_frames_duration_and_join() -> None:
    clip = silent_mp3(1.0)
    id3 = b"ID3\x04\x00\x00\x00\x00\x00\x0a" + b"\x00" * 10  # a 10-byte ID3v2 tag in front
    assert abs(mp3_duration(clip) - 1.0) < 0.03 and mp3_duration(id3 + clip) == mp3_duration(clip)
    joined = join_mp3([id3 + clip, clip])
    assert not joined.startswith(b"ID3") and abs(mp3_duration(joined) - 2 * mp3_duration(clip)) < 0.001
    assert mp3_duration(b"not audio at all") == 0


def _wav(path: Path, seconds: float, rate: int = 8000) -> Path:
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(b"\x00\x00" * int(rate * seconds))
    return path


def test_wav_join_and_srt(tmp_path: Path) -> None:
    a, b = _wav(tmp_path / "a.wav", 1.0), _wav(tmp_path / "b.wav", 0.5)
    joined = join_wav([a, b], tmp_path / "ab.wav", gap_s=0.5)
    assert wav_duration(joined) == 2.0
    with pytest.raises(ValueError):
        join_wav([a, _wav(tmp_path / "c.wav", 1.0, rate=16000)], tmp_path / "bad.wav")
    assert srt_timestamp(3725.5) == "01:02:05,500"
    assert srt([("one  two", 1.25), ("three", 2)]) == "1\n00:00:00,000 --> 00:00:01,250\none two\n\n2\n00:00:01,250 --> 00:00:03,250\nthree\n"


def test_chunk_text() -> None:
    text = "First sentence. " + "word " * 120 + "end. Last one!"
    chunks = chunk_text(text, 100)
    assert all(len(c) <= 100 for c in chunks) and " ".join(chunks).split() == text.split()
    assert chunk_text("  ", 50) == [] and chunk_text("Short. Also short.", 100) == ["Short. Also short."]


async def test_tts_requests_bypass_the_llm_limiter(tmp_path: Path) -> None:
    fake = FakeLLM()
    settings = LLMSettings(base_url="http://fake.local/v1", api_key="k", model="m", mini_model="m")
    client = LLMClient(settings, ledger=UsageLedger(tmp_path / "u.jsonl"), sink=MemorySink(), concurrency=1, transport=fake.transport())
    provider = OpenRouterTTS(client, base_url="http://fake.local/v1", api_key="k", model="tts-model", voice="nova")
    async with client.limiter.slot():  # every LLM slot is taken
        clip = await asyncio.wait_for(provider.synthesize("Hello there, audience. " * 3, tmp_path / "c.mp3", node_key="1"), 5)
    assert clip.seconds > 0 and (tmp_path / "c.mp3").read_bytes()[:2] == b"\xff\xfb"
    [call] = [c for c in fake.calls if c.path.endswith("/audio/speech")]
    assert call.body == {"model": "tts-model", "input": ("Hello there, audience. " * 3).strip(), "voice": "nova", "response_format": "mp3"}
    await client.aclose()
    usage = (tmp_path / "u.jsonl").read_text(encoding="utf-8")
    assert '"kind": "tts"' in usage and '"node_key": "1"' in usage


async def test_long_narration_is_split_into_requests(tmp_path: Path) -> None:
    fake = FakeLLM()
    settings = LLMSettings(base_url="http://fake.local/v1", api_key="k", model="m", mini_model="m")
    client = LLMClient(settings, ledger=UsageLedger(None), sink=MemorySink(), concurrency=2, transport=fake.transport())
    provider = OpenRouterTTS(client, base_url="http://fake.local/v1", api_key="k", model="t")
    text = ("This sentence is part of a very long narration. " * 120).strip()
    clip = await provider.synthesize(text, tmp_path / "long.mp3")
    calls = [c for c in fake.calls if c.path.endswith("/audio/speech")]
    assert len(calls) == 2 and all(len(c.body["input"]) <= 3500 for c in calls)
    assert abs(clip.seconds - 0.4 * len(text.split())) < 1.0  # both parts, joined
    await client.aclose()
