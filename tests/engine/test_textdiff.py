"""engine.util.textdiff: hunks stay correct and fast on large inputs."""

from __future__ import annotations

import random
import time

import pytest

from engine.util.textdiff import DiffCancelled, Hunk, apply_hunks, diff_hunks


def _roundtrip(old: str, new: str) -> list[Hunk]:
    hunks = diff_hunks(old, new)
    assert apply_hunks(old, hunks) == new
    for h in hunks:
        assert old[h.start:h.end] == h.removed
    assert all(a.end <= b.start for a, b in zip(hunks, hunks[1:]))
    return hunks


def _section(rng: random.Random, paragraphs: int = 250, words: int = 60) -> str:
    vocab = [f"term{rng.randrange(10**4)}" for _ in range(3000)]
    return "\n\n".join(" ".join(rng.choice(vocab) for _ in range(words)) + "." for _ in range(paragraphs))


def _edit_words(text: str, rng: random.Random, share: float) -> str:
    """Replace `share` of the words in place (paragraph breaks survive)."""
    out = []
    for para in text.split("\n\n"):
        ws = para.split(" ")
        for i in range(len(ws)):
            if rng.random() < share:
                ws[i] = "EDIT" + str(rng.randrange(100))
        out.append(" ".join(ws))
    return "\n\n".join(out)


def test_hundred_kb_section_with_three_percent_edits_is_fast() -> None:
    rng = random.Random(1)
    old = _section(rng, paragraphs=300, words=60)
    assert len(old) > 100_000
    new = _edit_words(old, rng, 0.03)
    t0 = time.perf_counter()
    hunks = _roundtrip(old, new)
    assert time.perf_counter() - t0 < 1.0
    assert 100 < len(hunks) < 1500  # fine-grained, not one giant hunk


def test_pathological_repeats_are_fast_and_correct() -> None:
    for old, new in (
        ("word " * 1200, "term " * 1200),
        ("word " * 1200, "word " * 600 + "term " + "word " * 599),
        ("a\n" * 3000, "a\n" * 1500 + "b\n" + "a\n" * 1499),
        ("x " * 20000, "y " * 20000),
    ):
        t0 = time.perf_counter()
        _roundtrip(old, new)
        assert time.perf_counter() - t0 < 1.0


def test_one_huge_paragraph_with_scattered_edits_uses_unique_words_as_anchors() -> None:
    rng = random.Random(2)
    old = " ".join(f"w{rng.randrange(10**6)}" for _ in range(12000))
    words = old.split(" ")
    for i in range(0, len(words), 40):
        words[i] = "EDIT"
    new = " ".join(words)
    t0 = time.perf_counter()
    hunks = _roundtrip(old, new)
    assert time.perf_counter() - t0 < 1.0 and len(hunks) > 50


def test_seeded_fuzz_roundtrip() -> None:
    rng = random.Random(7)
    alphabet = ["a", "b", "ab", " ", "\n", "\n\n", ". ", "é", "\U0001f600", "x1", "word", "term", "$x$", "\r\n"]
    for _ in range(1500):
        old = "".join(rng.choice(alphabet) for _ in range(rng.randint(0, 80)))
        chars = list(old)
        for _ in range(rng.randint(0, 6)):
            pos = rng.randint(0, len(chars))
            op = rng.random()
            if op < 0.4:
                chars.insert(pos, rng.choice(alphabet))
            elif op < 0.7 and chars:
                del chars[min(pos, len(chars) - 1)]
            elif chars:
                chars[min(pos, len(chars) - 1)] = rng.choice(alphabet)
        _roundtrip(old, "".join(chars))


def test_astral_offsets_are_code_points() -> None:
    old = "\U0001f600\U0001f600 start middle end"
    new = "\U0001f600\U0001f600 start centre end"
    (hunk,) = _roundtrip(old, new)
    assert (hunk.start, hunk.end) == (old.index("middle"), old.index("middle") + 6)


def test_should_stop_cancels_the_diff() -> None:
    rng = random.Random(3)
    old = _section(rng, paragraphs=100)
    new = _edit_words(old, rng, 0.1)
    with pytest.raises(DiffCancelled):
        diff_hunks(old, new, should_stop=lambda: True)


def test_a_spent_time_budget_degrades_to_coarse_hunks_but_stays_correct() -> None:
    rng = random.Random(4)
    old = _section(rng, paragraphs=60)
    new = _edit_words(old, rng, 0.05)
    hunks = diff_hunks(old, new, budget_s=0.0)
    assert apply_hunks(old, hunks) == new and len(hunks) <= 2


def test_granularity_and_merging() -> None:
    old = "the quick brown fox jumps over the lazy dog.\n\nSecond para."
    new = "a slow brown dog jumps over the lazy fox.\n\nSecond para here."
    hunks = _roundtrip(old, new)
    assert hunks[0] == Hunk(0, 19, "the quick brown fox", "a slow brown dog")
    assert diff_hunks(old, old) == [] and diff_hunks(old, new, base=10)[0].start == 10


# ============================================================ review round 2
def _low_vocabulary() -> tuple[str, str]:
    old = " ".join("word " * 300 + f"uniq{i}" for i in range(80))
    return old, old.replace("word", "term")


def test_low_vocabulary_input_is_fast_and_correct() -> None:
    old, new = _low_vocabulary()
    t0 = time.perf_counter()
    hunks = _roundtrip(old, new)
    assert time.perf_counter() - t0 < 3.0 and hunks
    for a, b in (("word " * 316, "term " * 316), ("a b " * 600, "b a " * 600)):
        t0 = time.perf_counter()
        _roundtrip(a, b)
        assert time.perf_counter() - t0 < 1.0


def test_the_real_diff_cancels_promptly_on_a_hard_input() -> None:
    import threading

    from engine.util.textdiff import diff_hunks_detailed

    old, new = _low_vocabulary()
    stop = threading.Event()
    threading.Timer(0.05, stop.set).start()
    t0 = time.perf_counter()
    with pytest.raises(DiffCancelled):
        diff_hunks_detailed(old, new, should_stop=stop.is_set)
    assert time.perf_counter() - t0 < 0.5


def test_degraded_blocks_are_counted() -> None:
    from engine.util.textdiff import diff_hunks_detailed

    old, new = _low_vocabulary()
    hunks, coarse = diff_hunks_detailed(old, new, budget_s=0.0)
    assert coarse >= 1 and apply_hunks(old, hunks) == new
    hunks2, coarse2 = diff_hunks_detailed("ab " * 400, "ba " * 400)  # nothing unique to anchor on
    assert apply_hunks("ab " * 400, hunks2) == "ba " * 400
    assert diff_hunks_detailed("one two", "one three")[1] == 0


def test_changed_lines_do_not_chain_into_one_giant_hunk() -> None:
    old = "".join(f"line {i} has some text\n" for i in range(3000))
    new = "".join(f"line {i} has other text\n" for i in range(3000))
    hunks = _roundtrip(old, new)
    assert len(hunks) > 1000 and max(len(h.removed) + len(h.added) for h in hunks) <= 400
