"""engine.util.anchors: text-quote anchors over Markdown source (code points)."""

from __future__ import annotations

import time

import pytest

from engine.util.anchors import CONTEXT, make_anchor, resolve_anchor, resolve_quote

EMOJI = "\N{GRINNING FACE}"
MATH_A = "\N{MATHEMATICAL DOUBLE-STRUCK CAPITAL A}"
LDQ, RDQ = "\N{LEFT DOUBLE QUOTATION MARK}", "\N{RIGHT DOUBLE QUOTATION MARK}"
RSQ = "\N{RIGHT SINGLE QUOTATION MARK}"
NBH = "\N{NON-BREAKING HYPHEN}"
NBSP = "\N{NO-BREAK SPACE}"
ELLIPSIS = "\N{HORIZONTAL ELLIPSIS}"
ZWSP = "\N{ZERO WIDTH SPACE}"

SENTENCE = "the generators of S must pairwise commute"
TEXT = (
    "Intro paragraph about stabilizer codes and their basic properties.\n\n"
    f"For a stabilizer group, {SENTENCE} for the eigenspace to be non-trivial. "
    "Otherwise the group contains minus identity.\n\nClosing remarks."
)


def _span(text: str, needle: str) -> tuple[int, int]:
    i = text.index(needle)
    return i, i + len(needle)


def _check(text: str, anchor: dict) -> None:
    assert anchor["start"] is not None and anchor["end"] is not None
    assert text[anchor["start"]:anchor["end"]] == anchor["quote"]


# ------------------------------------------------------------------ make_anchor
def test_make_anchor_context_and_bounds() -> None:
    start, end = _span(TEXT, SENTENCE)
    a = make_anchor(TEXT, start, end)
    assert a["quote"] == SENTENCE and (a["start"], a["end"]) == (start, end)
    assert a["prefix"] == TEXT[start - CONTEXT:start] and len(a["prefix"]) == CONTEXT
    assert a["suffix"] == TEXT[end:end + CONTEXT]
    head = make_anchor(TEXT, 0, 5)
    assert head["prefix"] == "" and head["quote"] == TEXT[:5]
    with pytest.raises(ValueError):
        make_anchor(TEXT, 5, len(TEXT) + 1)
    with pytest.raises(ValueError):
        make_anchor(TEXT, 6, 5)


# ------------------------------------------------------ offsets are code points
def test_offsets_count_code_points_not_utf16_units() -> None:
    text = f"{EMOJI}{EMOJI} {MATH_A}-modules, then {SENTENCE}. {MATH_A}{EMOJI} end"
    start, end = _span(text, SENTENCE)
    # Python indices are code points; UTF-16 would be larger by the astral count.
    assert start == len(f"{EMOJI}{EMOJI} {MATH_A}-modules, then ")
    a = make_anchor(text, start, end)
    _check(text, a)
    assert resolve_anchor(text, a)["start"] == start


def test_astral_characters_inside_the_range() -> None:
    quote = f"the {EMOJI} symbol and {MATH_A} field"
    text = f"{EMOJI * 3} lead. We use {quote} throughout."
    a = make_anchor(text, *_span(text, quote))
    shifted = f"{EMOJI * 10}{MATH_A * 2} extra lead. " + text[len(f"{EMOJI * 3} lead. "):]
    r = resolve_anchor(shifted, a)
    _check(shifted, r)
    assert r["quote"] == quote


def test_edit_before_range_moves_offsets() -> None:
    a = make_anchor(TEXT, *_span(TEXT, SENTENCE))
    edited = "A brand new first sentence that was inserted. " + TEXT
    r = resolve_anchor(edited, a)
    _check(edited, r)
    assert r["start"] == a["start"] + len("A brand new first sentence that was inserted. ")
    assert r["prefix"] and r["suffix"]


def test_stored_offsets_still_valid_are_kept() -> None:
    a = make_anchor(TEXT, *_span(TEXT, SENTENCE))
    assert resolve_anchor(TEXT, a) == a


# ------------------------------------------------------------- exact, duplicates
def test_duplicate_quote_disambiguated_by_context() -> None:
    text = "alpha beta. The value is bounded. gamma delta. The value is bounded. epsilon."
    first, second = (m for m in [text.index("The value"), text.rindex("The value")])
    a = make_anchor(text, second, second + len("The value is bounded."))
    # Stored offsets are stale (text grew at the front) so the exact scan runs.
    grown = "Preamble that was added. " + text
    r = resolve_anchor(grown, {**a, "start": 0, "end": 3})
    assert r["start"] == grown.rindex("The value")
    a1 = make_anchor(text, first, first + len("The value is bounded."))
    r1 = resolve_anchor(grown, {**a1, "start": 0, "end": 3})
    assert r1["start"] == grown.index("The value")


def test_duplicate_without_context_prefers_nearest_to_stored_start() -> None:
    text = "x. Same words here. y. Same words here. z. Same words here."
    positions = [i for i in range(len(text)) if text.startswith("Same words here.", i)]
    anchor = {"quote": "Same words here.", "prefix": "", "suffix": "", "start": positions[1] + 1, "end": positions[1] + 5}
    assert resolve_anchor(text, anchor)["start"] == positions[1]
    anchor["start"] = len(text)
    assert resolve_anchor(text, anchor)["start"] == positions[2]


# ---------------------------------------------------------------- whitespace
def test_whitespace_normalised_match_maps_back_to_original_offsets() -> None:
    a = make_anchor(TEXT, *_span(TEXT, SENTENCE))
    reflowed = TEXT.replace("generators of S must", "generators\n  of S\tmust").replace("pairwise commute", "pairwise   commute")
    r = resolve_anchor(reflowed, a)
    _check(reflowed, r)
    assert r["quote"] == "the generators\n  of S\tmust pairwise   commute"
    assert r["start"] == reflowed.index("the generators")


def test_whitespace_collapsed_in_text_but_quote_has_newlines() -> None:
    text = "One two three four five six seven eight."
    anchor = {"quote": "two three\nfour five", "prefix": "One ", "suffix": " six", "start": None, "end": None}
    r = resolve_anchor(text, anchor)
    assert r["quote"] == "two three four five"
    _check(text, r)


# ------------------------------------------------------------------- fuzzy
def test_fuzzy_match_after_small_edit() -> None:
    a = make_anchor(TEXT, *_span(TEXT, SENTENCE))
    edited = TEXT.replace("must pairwise commute", "must always pairwise commute")
    r = resolve_anchor(edited, a)
    _check(edited, r)
    assert r["quote"].startswith("the generators of S must")
    assert "commute" in r["quote"]


def test_fuzzy_updates_quote_to_matched_text() -> None:
    a = make_anchor(TEXT, *_span(TEXT, SENTENCE))
    edited = TEXT.replace("generators", "generator elements")
    r = resolve_anchor(edited, a)
    _check(edited, r)
    assert "elements" in r["quote"]


def test_fuzzy_never_matches_unrelated_text() -> None:
    a = make_anchor(TEXT, *_span(TEXT, SENTENCE))
    unrelated = (
        "Photosynthesis converts light energy into chemical energy stored in glucose. "
        "Chloroplasts contain chlorophyll which absorbs mostly blue and red light. " * 3
    )
    r = resolve_anchor(unrelated, a)
    assert r["start"] is None and r["end"] is None and r["quote"] == SENTENCE


def test_fuzzy_threshold_rejects_heavily_rewritten_quote() -> None:
    a = make_anchor(TEXT, *_span(TEXT, SENTENCE))
    rewritten = TEXT.replace(SENTENCE, "all the pairwise generated operators must be mutually exchanging")
    r = resolve_anchor(rewritten, a)
    assert r["start"] is None


def test_fuzzy_near_stored_offset_without_seed_hits() -> None:
    quote = "abcdefg hijklmn opqrst"
    text = "xx abcdeFg hijkLmn opqRst yy"
    anchor = {"quote": quote, "prefix": "xx ", "suffix": " yy", "start": 3, "end": 3 + len(quote)}
    r = resolve_anchor(text, anchor)
    # Every 8-gram seed is broken, so only the stored-offset window can find it.
    assert r["start"] == 3
    _check(text, r)


# ------------------------------------------------------------------ orphans
def test_deleted_quote_is_orphaned_and_keeps_its_context() -> None:
    a = make_anchor(TEXT, *_span(TEXT, SENTENCE))
    gone = TEXT.replace(f"For a stabilizer group, {SENTENCE} for the eigenspace to be non-trivial. ", "")
    r = resolve_anchor(gone, a)
    assert r["start"] is None and r["end"] is None
    assert r["quote"] == SENTENCE and r["prefix"] == a["prefix"] and r["suffix"] == a["suffix"]


def test_empty_quote_or_empty_text_is_orphaned() -> None:
    assert resolve_anchor(TEXT, {"quote": "", "prefix": "", "suffix": "", "start": 2, "end": 2})["start"] is None
    assert resolve_anchor("", make_anchor(TEXT, 0, 10))["start"] is None
    assert resolve_quote(TEXT, "")["start"] is None


def test_orphaned_anchor_can_be_reattached_when_text_returns() -> None:
    a = make_anchor(TEXT, *_span(TEXT, SENTENCE))
    orphan = resolve_anchor("nothing relevant here at all", a)
    assert orphan["start"] is None
    again = resolve_anchor(TEXT, orphan)
    _check(TEXT, again)


# ---------------------------------------------------------------- resolve_quote
def test_resolve_quote_exact_and_whitespace() -> None:
    r = resolve_quote(TEXT, SENTENCE)
    _check(TEXT, r)
    assert r["start"] == TEXT.index(SENTENCE)
    r2 = resolve_quote(TEXT, "the generators  of S\nmust pairwise commute")
    assert r2["quote"] == SENTENCE and r2["start"] == TEXT.index(SENTENCE)


def test_resolve_quote_first_occurrence_or_context() -> None:
    text = "Twice. It repeats. Then more. It repeats. End."
    assert resolve_quote(text, "It repeats.")["start"] == text.index("It repeats.")
    assert resolve_quote(text, "It repeats.", prefix="Then more. ")["start"] == text.rindex("It repeats.")


@pytest.mark.parametrize(
    "quoted, text_sentence",
    [
        (f"It{RSQ}s a well-known fact", "It's a well-known fact"),
        ("It's a well-known fact", f"It{RSQ}s a well-known fact"),
        (f"{LDQ}bounded operators{RDQ} are", '"bounded operators" are'),
        (f"well{NBH}known fact", "well-known fact"),
        (f"a{NBSP}well-known{NBSP}fact", "a well-known fact"),
        (f"well{ZWSP}-known", "well-known"),
        ("an important result", "an **important** result"),
        ("an important result", "an _important_ result"),
        ("use the foo_bar function", "use the `foo_bar` function"),
    ],
)
def test_resolve_quote_typographic_tolerance(quoted: str, text_sentence: str) -> None:
    text = f"Lead sentence. {text_sentence}. Trailing sentence."
    r = resolve_quote(text, quoted)
    _check(text, r)
    lo = text.index(text_sentence)
    assert lo <= r["start"] and r["end"] <= lo + len(text_sentence)
    assert r["end"] - r["start"] >= len(text_sentence) - 6  # only markers / quote marks may be left out


def test_resolve_quote_strips_surrounding_quote_marks_and_ellipses() -> None:
    for wrapped in (f'"{SENTENCE}"', f"{LDQ}{SENTENCE}{RDQ}", f"{ELLIPSIS}{SENTENCE}{ELLIPSIS}", f"...{SENTENCE}...", f"'{SENTENCE}.'"):
        r = resolve_quote(TEXT, wrapped)
        _check(TEXT, r)
        assert r["quote"].startswith("the generators") and "commute" in r["quote"], wrapped


def test_resolve_quote_ellipsis_in_the_middle_spans_the_elided_text() -> None:
    for ell in (ELLIPSIS, "..."):
        r = resolve_quote(TEXT, f"the generators {ell} must pairwise commute")
        _check(TEXT, r)
        assert r["quote"] == SENTENCE


def test_resolve_quote_ellipsis_segments_must_be_close() -> None:
    far = "start marker here. " + "filler words go on. " * 200 + "end marker there."
    assert resolve_quote(far, f"start marker here {ELLIPSIS} end marker there", fuzzy=False)["start"] is None


def test_resolve_quote_fuzzy_and_orphan() -> None:
    r = resolve_quote(TEXT, "the generators of S must pair-wise commute")
    _check(TEXT, r)
    assert r["start"] == TEXT.index("the generators")
    assert resolve_quote(TEXT, "a sentence that never occurs in this document anywhere")["start"] is None
    assert resolve_quote(TEXT, "quantum chromodynamics lattice simulation", fuzzy=True)["start"] is None


def test_resolve_quote_emphasis_in_text_with_astral_prefix() -> None:
    text = f"{EMOJI}{EMOJI} Then **the {MATH_A}-module** is *free* of rank two."
    r = resolve_quote(text, f"the {MATH_A}-module is free of rank two")
    _check(text, r)
    assert r["start"] == text.index("the ")
    assert r["end"] == len(text) - 1


# ------------------------------------------------------------------ performance
def test_performance_on_a_large_text() -> None:
    para = "The method relies on careful reasoning about each concept and shows how it connects to practice. "
    big = "".join(f"{para}Paragraph number {i} adds distinct detail {i * 7}.\n\n" for i in range(400))
    assert len(big) > 40_000
    target = "Paragraph number 321 adds distinct detail 2247."
    a = make_anchor(big, *_span(big, target))
    t0 = time.perf_counter()
    inserted = "Inserted sentence. " + big
    exact = resolve_anchor(inserted, a)
    reflowed = resolve_anchor(big.replace("Paragraph number 321 adds", "Paragraph  number\n321 adds"), a)
    fuzzy = resolve_anchor(big.replace("distinct detail 2247", "distinct details 2247"), a)
    orphan = resolve_anchor(big.replace("Paragraph number 321", "Chapter"), {**a, "quote": "completely different text about quarks"})
    quote = resolve_quote(big, "Paragraph number 321 adds" + NBSP + "distinct detail 2247.")
    elapsed = time.perf_counter() - t0
    _check(inserted, exact)
    assert reflowed["start"] is not None
    assert fuzzy["start"] is not None and "details" in fuzzy["quote"]
    assert orphan["start"] is None
    _check(big, quote)  # curly quotes in the quote resolve to the straight text
    assert quote["quote"] == target
    assert elapsed < 2.0, elapsed


def test_performance_many_repeated_seed_hits() -> None:
    big = "aaaa bbbb cccc dddd eeee. " * 2500
    anchor = {"quote": "aaaa bbbb cccc dddd eeeX. aaaa bbbb ccXc dddd eeee.", "prefix": "", "suffix": "", "start": 100, "end": 150}
    t0 = time.perf_counter()
    resolve_anchor(big, anchor)
    assert time.perf_counter() - t0 < 2.0
