"""engine.util.anchors: text-quote anchors over Markdown source (code points)."""

from __future__ import annotations

import time

import pytest

from engine.util.anchors import (
    CONTEXT,
    LEVELS,
    make_anchor,
    resolve_anchor,
    resolve_anchor_detailed,
    resolve_quote,
    resolve_quote_detailed,
)

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


def test_duplicate_without_context_is_orphaned_not_pinned_to_stale_offsets() -> None:
    text = "x. Same words here. y. Same words here. z. Same words here."
    positions = [i for i in range(len(text)) if text.startswith("Same words here.", i)]
    bare = {"quote": "Same words here.", "prefix": "", "suffix": "", "start": positions[1] + 1, "end": positions[1] + 5}
    assert resolve_anchor(text, bare)["start"] is None
    assert resolve_anchor(text, {**bare, "start": positions[1], "end": positions[1] + 16})["start"] is None  # even when it still "holds"
    with_context = {**bare, "start": positions[1] + 1, "end": positions[1] + 5, "prefix": "y. ", "suffix": " z. Same"}
    assert resolve_anchor(text, with_context)["start"] == positions[1]


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
    assert resolve_quote(text, "It repeats.")["start"] is None  # short and ambiguous: orphan, not a guess
    assert resolve_quote(text, "It repeats.", prefix="Then more. ")["start"] == text.rindex("It repeats.")
    long = "Twice over. This sentence is long enough to count as a quote. Then more. This sentence is long enough to count as a quote. End."
    assert resolve_quote(long, "This sentence is long enough to count as a quote.")["start"] == long.index("This sentence")  # same text: first


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
    assert r["start"] == text.index("**the")  # the match does not stop inside the opening `**`
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


# ============================================================ review round 1
def _detail(text: str, quote: str, **kw):
    anchor, level = resolve_quote_detailed(text, quote, **kw)
    assert level in LEVELS
    return anchor, level


@pytest.mark.parametrize(
    "text, quote",
    [
        ("the cat sat on the mat", '"a"'),
        ("the party was great", "'art'"),
        ("born in 2015, died in 2019", "5."),
        ("This was a test of things", "is"),
        ("It was a long day. It was a bad day.", "It ... a"),
        ("Alpha beta gamma delta. Epsilon zeta eta theta. Iota kappa lambda mu.", "Alpha beta gamma ... lambda mu"),
    ],
)
def test_resolve_quote_has_no_false_positives_on_short_or_weak_quotes(text: str, quote: str) -> None:
    anchor, level = _detail(text, quote)
    assert anchor["start"] is None and level == "orphan", anchor


def test_short_quote_needs_word_boundaries_and_a_single_occurrence() -> None:
    assert resolve_quote("The mouse sat. It is fine here.", "mouse")["start"] == 4
    assert resolve_quote("The mouse and the other mouse.", "mouse")["start"] is None  # two words: ambiguous
    assert resolve_quote("The mouse and the other mouse.", "mouse", prefix="other ")["start"] == 24
    assert resolve_quote("mousetrap theory", "mouse")["start"] is None  # inside a word
    assert resolve_quote("The cat sat on it.", "cat")["start"] is None  # three characters, nothing to vouch for the place
    assert resolve_quote("The cat sat on it.", "cat", prefix="The ")["start"] == 4


def test_ellipsis_paraphrase_does_not_swallow_a_long_span() -> None:
    filler = "Some unrelated sentence about nothing in particular. " * 25
    text = f"The generators of the stabilizer group {filler}and so the code space is nontrivial."
    anchor, _ = _detail(text, "The generators of the stabilizer group ... then the code space is trivial")
    assert anchor["start"] is None
    ok, level = _detail(text, "The generators of the stabilizer group ... and so the code space is nontrivial.")
    assert ok["start"] is None  # 1300 characters elided: more than a quote may stand for


def test_stored_offsets_without_context_agreement_do_not_pin_a_wrong_duplicate() -> None:
    text = "x = 1\nx = 2\nx = 3\n"
    start = text.index("x = 2")
    anchor = make_anchor(text, start, start + 1)  # the `x` of line 2
    edited = text.replace("x = 1\n", "")
    assert edited[start:start + 1] == "x"  # the stored offsets point at an `x` ... of line 3's neighbour
    r, level = resolve_anchor_detailed(edited, anchor)
    assert r["start"] in (None, 0)  # the deleted line was the prefix: the right `x` or an orphan, never line 3's


def test_stored_offsets_pick_the_right_sentence_when_the_text_before_changed() -> None:
    text = "Intro. The model is good for small inputs. Middle part. The model is bad for large inputs. End."
    quote = "The model is"
    start = text.rindex(quote)
    anchor = make_anchor(text, start, start + len(quote))
    edited = text.replace("Intro. ", "Intro. A short added remark here. ", 1).replace("The model is good for small inputs. ", "")
    r = resolve_anchor(edited, anchor)
    assert r["start"] == edited.rindex(quote) and edited[r["end"]:].startswith(" bad")


def test_stored_offsets_are_trusted_when_context_agrees_or_quote_is_unique() -> None:
    text = "One line.\nSame words appear here today.\nSame words appear here today.\n"
    start = text.rindex("Same words appear here today.")
    a = make_anchor(text, start, start + len("Same words appear here today."))
    r, level = resolve_anchor_detailed(text, a)
    assert (r["start"], level) == (start, "stored")


def test_levels_are_reported() -> None:
    a = make_anchor(TEXT, *_span(TEXT, SENTENCE))
    assert resolve_anchor_detailed(TEXT, a)[1] == "stored"
    assert resolve_anchor_detailed("Pre. " + TEXT, a)[1] == "exact"
    assert resolve_anchor_detailed(TEXT.replace("must pairwise", "must\n pairwise"), a)[1] == "whitespace"
    assert resolve_anchor_detailed(TEXT.replace("must pairwise commute", "must always pairwise commute"), a)[1] == "fuzzy"
    assert resolve_anchor_detailed("unrelated text only", a)[1] == "orphan"
    assert resolve_quote_detailed(TEXT, f"{LDQ}{SENTENCE}{RDQ}")[1] == "tolerant"
    assert resolve_quote_detailed(TEXT, SENTENCE)[1] == "exact"


def test_nfc_and_nfd_texts_match_with_offsets_in_the_original() -> None:
    nfd = "Cafe\N{COMBINING ACUTE ACCENT} culture has a long history in the old town."
    nfc = "Caf\N{LATIN SMALL LETTER E WITH ACUTE} culture has a long history in the old town."
    r, level = resolve_anchor_detailed(nfd, {"quote": nfc, "prefix": "", "suffix": "", "start": None, "end": None})
    assert level == "tolerant" and (r["start"], r["end"]) == (0, len(nfd.split(" has")[0]) + len(" has a long history in the old town."))
    _check(nfd, r)
    r2 = resolve_anchor(nfc, {"quote": nfd, "prefix": "", "suffix": "", "start": None, "end": None})
    _check(nfc, r2)


@pytest.mark.parametrize("bad", [True, 3.0, "3", -1, 10**9, None])
def test_non_int_or_out_of_range_offsets_are_ignored(bad) -> None:
    a = make_anchor(TEXT, *_span(TEXT, SENTENCE))
    r = resolve_anchor("Pre. " + TEXT, {**a, "start": bad, "end": bad})
    _check("Pre. " + TEXT, r)


def test_markers_next_to_a_tolerant_match_are_not_split() -> None:
    text = "Intro text. This is **very important** for the reader. More text follows."
    r = resolve_quote(text, "This is very important for the reader.")
    _check(text, r)
    assert r["quote"] == "This is **very important** for the reader."
    text2 = "Use the **foo_bar** helper and the foo_bar_baz name."
    r2 = resolve_quote(text2, "Use the foo_bar helper and")
    assert r2["quote"] == "Use the **foo_bar** helper and"
    assert resolve_quote(text2, "the foo_bar_baz name")["quote"] == "the foo_bar_baz name"


def test_fuzzy_span_stays_close_to_the_quote_and_on_word_boundaries() -> None:
    sentence = "Each stabilizer generator measures one parity check of the encoded block and reports a single syndrome bit."
    text = "Opening words precede it. " + sentence + " Closing words follow it directly after."
    edited = text.replace("measures one parity", "measures exactly one parity")
    a = make_anchor(text, *_span(text, sentence))
    r, level = resolve_anchor_detailed(edited, a)
    assert level == "fuzzy"
    _check(edited, r)
    assert r["quote"].startswith("Each stabilizer") and r["quote"].endswith("syndrome bit.")
    assert abs(len(r["quote"]) - len(sentence)) <= 12


def test_fuzzy_refuses_between_equally_similar_siblings() -> None:
    text = "\n\n".join(f"Theorem {i}. Let G be a finite group of order {i * 7} acting on a set X freely." for i in (1, 2, 3, 4))
    quote = "Theorem 9. Let G be a finite group of order 63 acting on a set X freely."
    assert resolve_quote(text, quote)["start"] is None


def test_long_quote_is_anchored_by_head_and_tail() -> None:
    import random

    rng = random.Random(5)
    words = [f"term{rng.randrange(10**4)}" for _ in range(900)]
    long_quote = " ".join(words[:500]) + "."  # > 2000 characters, no repetition
    assert len(long_quote) > 2000
    text = "Header paragraph.\n\n" + long_quote + "\n\nFooter paragraph."
    a = make_anchor(text, *_span(text, long_quote))
    edited = "New first line.\n\n" + text.replace(words[250], words[250] + " inserted words", 1)
    r, level = resolve_anchor_detailed(edited, a)
    assert level == "fuzzy" and r["start"] == len("New first line.\n\nHeader paragraph.\n\n")
    assert abs((r["end"] - r["start"]) - len(long_quote)) < 100
    assert resolve_anchor(text.replace(long_quote[:300], "X" * 300), a)["start"] is None  # the head is gone


def test_periodic_text_cannot_fake_a_head_and_tail_match() -> None:
    para = "Stabilizer formalism makes every Clifford operation easy to track through conjugation and so on. " * 30
    long_quote = para[:2800]
    text = "Header paragraph.\n\n" + long_quote + "\n\nFooter paragraph."
    a = make_anchor(text, *_span(text, long_quote))
    head_edited = text.replace("easy to track", "simple to track", 3)  # destroys the head; later periods look alike
    assert resolve_anchor(head_edited, a)["start"] is None


def test_repeated_text_beyond_the_scan_cap_is_never_silently_wrong() -> None:
    text = "ab " * 3000
    a = {"quote": "ab ab ab ab", "prefix": text[2968:3000], "suffix": text[3011:3043], "start": 3000, "end": 3000 + 11}
    r = resolve_anchor(text, a)
    assert r["start"] is not None and abs(r["start"] - 3000) < 12  # a window around the stored offset
    assert resolve_quote(text, "ab ab ab ab")["start"] is None  # nothing singles one out
    assert resolve_anchor(text, {**a, "start": None, "end": None})["start"] is None  # periodic: nothing singles one out


def test_two_kb_quote_in_a_hundred_kb_section_is_fast() -> None:
    import random

    rng = random.Random(3)
    vocab = [f"w{rng.randrange(10**5)}" for _ in range(4000)]
    text = "\n\n".join(" ".join(rng.choice(vocab) for _ in range(120)) + "." for _ in range(130))
    assert len(text) > 90_000
    start = text.index("\n\n", 50_000) + 2
    quote = text[start:start + 2000]
    a = make_anchor(text, start, start + 2000)
    for variant in (
        "Lead sentence. " + text,                                                # exact
        text.replace(quote[100:110], "ZZZZZ", 1),                                # edit inside the quote
        text.replace(quote[:40], "Q" * 40, 1),                                   # head destroyed
    ):
        t0 = time.perf_counter()
        resolve_anchor(variant, a)
        assert time.perf_counter() - t0 < 1.0


# ============================================================ review round 2
SUBWORD = "Let $x_1$ and $x_2$ be the two inputs of the comparator. The network compares x with y and then outputs the larger one."


def test_sub_word_anchor_keeps_its_true_position_when_the_context_still_matches() -> None:
    a = make_anchor(SUBWORD, 5, 6)  # the `x` of $x_1$
    r = resolve_anchor("Note. " + SUBWORD, a)
    assert (r["start"], r["end"]) == (11, 12)
    r2 = resolve_anchor(SUBWORD.replace("comparator", "comparator circuit"), a)
    assert r2["start"] == 5
    far = make_anchor(SUBWORD, SUBWORD.index("x with y"), SUBWORD.index("x with y") + 1)  # the bare word `x`
    assert resolve_anchor("Note. " + SUBWORD, far)["start"] == SUBWORD.index("x with y") + 6


def test_stored_anchor_without_context_whose_quote_repeats_is_orphaned() -> None:
    text = "alpha beta gamma. alpha beta gamma."
    bare = {"quote": "alpha beta gamma.", "prefix": "", "suffix": "", "start": 18, "end": 35}
    assert text[18:35] == bare["quote"]
    assert resolve_anchor(text, bare)["start"] is None


@pytest.mark.parametrize("seed", range(6))
def test_short_selections_survive_edits_elsewhere_or_orphan_never_move(seed: int) -> None:
    import random

    rng = random.Random(seed)
    vocab = ["".join(rng.choice("abcdefghijklmnoprstuvwxyz") for _ in range(rng.randint(3, 9))) for _ in range(500)]
    text = " ".join(rng.choice(vocab) for _ in range(500))
    total = orphans = 0
    for _ in range(300):
        words = rng.randint(0, 3)
        if words == 0:  # a 1-4 character selection, possibly inside a word
            start = rng.randrange(60, len(text) - 80)
            end = start + rng.randint(1, 4)
        else:
            i = rng.randrange(5, 480)
            toks = text.split(" ")
            start = len(" ".join(toks[:i])) + 1
            end = start + len(" ".join(toks[i:i + words]))
        if not text[start:end].strip():
            continue
        anchor = make_anchor(text, start, end)
        pos = rng.choice([rng.randrange(0, max(1, start - 80)), rng.randrange(min(len(text), end + 80), len(text) + 1)])
        if rng.random() < 0.5:
            chunk = "".join(rng.choice(vocab) + " " for _ in range(rng.randint(1, 8)))
            edited, shift = text[:pos] + chunk + text[pos:], (len(chunk) if pos <= start else 0)
        else:
            cut = min(rng.randint(1, 30), start - pos if pos < start else len(text) - pos)
            edited, shift = text[:pos] + text[pos + cut:], (-cut if pos < start else 0)
        r = resolve_anchor(edited, anchor)
        total += 1
        if r["start"] is None:
            orphans += 1
            continue
        assert r["start"] == start + shift, (seed, text[start:end], r["start"], start + shift)
    assert total > 200 and orphans / total <= 0.03, (orphans, total)


def test_citation_markers_are_dropped_in_the_tolerant_view() -> None:
    text = "The code corrects any single-qubit error [kb_report_ab12cd34_page_3_1] and detects two errors [web_x_1] in a row."
    r = resolve_quote(text, "The code corrects any single-qubit error and detects two errors in a row.")
    _check(text, r)
    assert r["quote"].endswith("in a row.") and r["start"] == 0


def test_emphasis_markers_inside_math_and_code_are_not_dropped() -> None:
    text = "We compute $2*3*4 = 24$ and call `x_i is_real` in the helper function of the library."
    assert resolve_quote(text, "234 = 24 and call")["start"] is None
    assert resolve_quote_detailed(text, "xi isreal in the helper function")[1] in ("fuzzy", "orphan")  # never the tolerant level
    ok = resolve_quote(text, "We compute $2*3*4 = 24$ and call")
    assert ok["start"] == 0


def test_nfd_span_end_includes_trailing_combining_marks() -> None:
    text = "Voil\N{LATIN SMALL LETTER A}\N{COMBINING GRAVE ACCENT} tout le monde, bonjour."
    r = resolve_quote(text, "Voil\N{LATIN SMALL LETTER A}", prefix="", suffix="")
    assert r["start"] is None or text[r["end"]:r["end"] + 1] != "\N{COMBINING GRAVE ACCENT}"
    r2 = resolve_quote(text, "Voil\N{LATIN SMALL LETTER A}\N{COMBINING GRAVE ACCENT} tout le")
    _check(text, r2)


def test_fuzzy_span_does_not_start_inside_emphasis() -> None:
    sentence = "Each stabilizer generator measures one parity check of the encoded block and reports a single syndrome bit."
    text = "Opening words. **" + sentence + "** Closing words follow it directly after."
    edited = text.replace("measures one parity", "measures exactly one parity")
    a = make_anchor(text, text.index("Each"), text.index("Each") + len(sentence))
    r = resolve_anchor(edited, a)
    assert r["start"] is not None and edited[r["start"]:r["start"] + 2] == "**" and edited[r["end"] - 2:r["end"]] == "**"


def test_long_quote_with_an_edit_in_its_head_or_tail_still_anchors() -> None:
    import random

    rng = random.Random(9)
    words = [f"term{rng.randrange(10**4)}" for _ in range(900)]
    quote = " ".join(words[:500]) + "."
    text = "Header paragraph.\n\n" + quote + "\n\nFooter paragraph."
    a = make_anchor(text, text.index("term"), text.index("term") + len(quote))
    for edited in (
        text.replace(words[3], words[3] + "X", 1),          # inside the head
        text.replace(words[497], words[497] + "Y", 1),      # inside the tail
        text.replace(words[2], "", 1),                      # a word deleted from the head
    ):
        r = resolve_anchor(edited, a)
        assert r["start"] == edited.index("term"), r
        assert abs((r["end"] - r["start"]) - len(quote)) <= 60


# ============================================================ fuzzy needs corroboration
FILLER = "Some unrelated prose about sorting networks and comparators that goes on. " * 70


def _near_duplicate_text(s1: str, s2: str) -> tuple[str, dict]:
    text = "Intro text here. " + s1 + " " + FILLER + s2 + " The end of the section."
    i = text.index(s1)
    return text, make_anchor(text, i, i + len(s1))


@pytest.mark.parametrize(
    "s1, s2",
    [
        ("Let $x_1$ be the smallest root of the polynomial $p$.", "Let $x_2$ be the smallest root of the polynomial $q$."),
        ("The gradient step updates all of the weights in the network at once.", "The gradient step updates all of the biases in the network at once."),
    ],
)
def test_a_deleted_sentence_is_not_re_attached_to_a_similar_one_far_away(s1: str, s2: str) -> None:
    text, anchor = _near_duplicate_text(s1, s2)
    deleted = text.replace(s1 + " ", "")
    r, level = resolve_anchor_detailed(deleted, anchor)
    assert r["start"] is None and level == "orphan", (level, r["start"])
    replaced = text.replace(s1, "A completely different remark replaces the original sentence entirely.")
    assert resolve_anchor(replaced, anchor)["start"] is None


def test_in_place_edits_with_intact_context_still_resolve_fuzzily() -> None:
    s1 = "Let $x_1$ be the smallest root of the polynomial $p$."
    text, anchor = _near_duplicate_text(s1, "Let $x_2$ be the smallest root of the polynomial $q$.")
    edited = text.replace("smallest root", "smallest real root")
    r, level = resolve_anchor_detailed(edited, anchor)
    assert level == "fuzzy" and r["start"] == edited.index(s1[:20])
    far_edit = "A new opening paragraph was typed in front. " + edited  # shifted, context intact
    r2, level2 = resolve_anchor_detailed(far_edit, anchor)
    assert level2 == "fuzzy" and r2["start"] == far_edit.index(s1[:20])


@pytest.mark.parametrize("seed", range(4))
def test_deleting_or_replacing_a_quote_never_lands_on_its_near_duplicate(seed: int) -> None:
    import random

    rng = random.Random(seed)
    words = [f"w{rng.randrange(10**5)}" for _ in range(300)]
    for _ in range(40):
        body = " ".join(rng.choice(words) for _ in range(14))
        twin = body.replace(body.split()[3], "changed", 1)  # a near-duplicate sentence
        pad = lambda: " ".join(rng.choice(words) for _ in range(rng.randint(150, 400)))  # noqa: E731
        text = f"{pad()}. {body}. {pad()}. {twin}. {pad()}."
        i = text.index(body)
        anchor = make_anchor(text, i, i + len(body))
        for edited in (text.replace(body + ". ", "", 1), text.replace(body, " ".join(rng.choice(words) for _ in range(14)), 1)):
            r = resolve_anchor(edited, anchor)
            assert r["start"] is None or edited[r["start"]:r["end"]] != twin, "re-attached to the near-duplicate"
