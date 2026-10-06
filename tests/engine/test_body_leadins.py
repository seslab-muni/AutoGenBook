"""One canonical lead-in form for body headings/title lines/rules (engine.assemble.markdown)."""

from __future__ import annotations

from engine.assemble.markdown import normalize_body


def norm(body: str, **kw) -> str:
    return normalize_body(body, "T", level=2, **kw)


def test_chapter2_shape_bold_italic_titles_and_rules() -> None:
    body = "***Alpha***\n\nFirst paragraph.\n\n---\n\n***Beta***\n\nSecond paragraph.\n\n---\n"
    assert norm(body) == "**Alpha.** First paragraph.\n\n**Beta.** Second paragraph."


def test_chapter4_shape_title_glued_to_paragraph() -> None:
    assert norm("**Architectural Foundations**\nThe socio-computational view.") == (
        "**Architectural Foundations.** The socio-computational view."
    )


def test_inline_bold_at_paragraph_start_untouched() -> None:
    body = "**Implication:** the firm participates in the market.\n\nNext."
    assert norm(body) == body


def test_lead_in_before_list_or_equation_stays_alone() -> None:
    assert norm("**Steps**\n- one\n- two") == "**Steps.**\n\n- one\n- two"
    assert norm("**Model**\n$$x = 1$$") == "**Model.**\n\n$$x = 1$$"
    assert norm("**A**\n**B**\ntext") == "**A.**\n\n**B.** text"
    assert norm("text\n\n**End**") == "text\n\n**End.**"


def test_terminal_punctuation_kept() -> None:
    assert norm("**Key terms:**\n- a") == "**Key terms:**\n\n- a"
    assert norm("**Key terms**:\ntext") == "**Key terms:** text"
    assert norm("__Why now?__\ntext") == "**Why now?** text"
    assert norm("# Done!\n\ntext") == "**Done!** text"


def test_emphasis_variants() -> None:
    for line in ("**x**", "***x***", "__x__", "___x___", "**_x_**", "_**x**_", "*__x__*", "__*x*__"):
        assert norm(f"{line}\ntext") == "**x.** text", line


def test_setext_and_lone_rules() -> None:
    assert norm("Title\n---\nText here.") == "**Title.** Text here."
    assert norm("Title\n=====\n\nText here.") == "**Title.** Text here."
    assert norm("One.\n\n---\n\nTwo.\n\n* * *\n\nThree.") == "One.\n\nTwo.\n\nThree."


def test_fenced_code_untouched() -> None:
    body = "Intro.\n\n```\n---\n**x**\n# h\n```\n\n~~~\n***y***\n~~~"
    assert norm(body) == body


def test_atx_headings_and_allow_headings() -> None:
    assert norm("# Sub\n\nMore.") == "**Sub.** More."
    body = "## Sub\n\n***Title***\n\n---\n\ntext"
    assert normalize_body(body, "T", level=1, allow_headings=True) == body
    assert normalize_body("# Sub\n\ntext", "T", level=2, allow_headings=True) == "### Sub\n\ntext"


# --- review round 1 -----------------------------------------------------------------


def test_setext_dash_needs_a_title_shaped_line() -> None:
    assert norm("First paragraph ends here.\n---\nSecond") == "First paragraph ends here.\n\nSecond"
    assert norm("line one\nline two\n---\nNext") == "line one\nline two\n\nNext"
    assert norm("---\nText.") == "Text."
    assert norm("A very long line of more than ten words used as a plain sentence here\n---\nX").startswith("A very long")
    assert "**" not in norm("A very long line of more than ten words used as a plain sentence here\n---\nX")
    # `===` is setext too, but only for the first line of a paragraph.
    assert norm("Para line.\nTitle\n===\nText") == "Para line.\nTitle\n\nText"


def test_presentation_path_keeps_head_behaviour() -> None:
    from engine.assemble.deck import slide_body

    def slide(text: str) -> str:
        return slide_body(normalize_body(text, "T", 2, lead_ins=False))

    assert slide("**Key benefits**\n- faster\n- cheaper") == "**Key benefits**\n- faster\n- cheaper"
    assert slide("### Why it matters\nOne-line takeaway sentence.\n- a") == "**Why it matters**\n\nOne-line takeaway sentence.\n- a"
    assert slide("**Takeaway**\nShort statement.") == "**Takeaway**\nShort statement."
    assert slide("Setup\n---\n- a") == "Setup\n- a"
    table = "| A | B |\n|---|---|\n| 1 | 2 |\n\n**Source**"
    assert slide(table) == table


def test_repeated_node_title_dropped() -> None:
    assert normalize_body("**T**\n\nBody.", "T", 1) == "Body."
    assert normalize_body("***T:***\nBody.", "T", 1) == "Body."
    assert normalize_body("T\n===\nBody.", "T", 1) == "Body."
    assert normalize_body("**Other**\n\nBody.", "T", 1) == "**Other.** Body."


def test_lead_in_text_is_not_mangled() -> None:
    assert norm("# *Emphasis* matters\n\ntext") == "***Emphasis* matters.** text"
    assert norm("# Using my_var_\n\ntext") == "**Using my_var_.** text"
    assert norm("## The **key** idea\n\ntext") == "**The key idea.** text"


def test_ordinary_text_after_a_lead_in_is_merged() -> None:
    assert norm("**T1**\n*Italic* start") == "**T1.** *Italic* start"
    assert norm("**T1**\n3.5 percent of firms") == "**T1.** 3.5 percent of firms"
    assert norm("**T1**\n-based approaches") == "**T1.** -based approaches"
    assert norm("**T1**\n+5% growth") == "**T1.** +5% growth"
    assert norm("**T1**\n**Note:** text") == "**T1.**\n\n**Note:** text"
    assert norm("**T1**\n1. one") == "**T1.**\n\n1. one"


def test_non_paragraph_lines_are_not_merged_into() -> None:
    table = "a | b\n--- | ---\n1 | 2"
    assert norm(f"**Table**\n{table}") == f"**Table.**\n\n{table}"
    for line in ("[^1]: x", "<div>x</div>", "\\begin{align}x\\end{align}"):
        assert norm(f"**Lead**\n{line}") == f"**Lead.**\n\n{line}", line


def test_indented_lines_are_left_alone() -> None:
    assert norm("- item\n\n  **Sub**\n\n  text") == "- item\n\n  **Sub**\n\n  text"
    assert norm("- item\n  continuation\n---") == "- item\n  continuation"
    assert norm("Code:\n\n    **x**\n    ---") == "Code:\n\n    **x**\n    ---"
    assert norm("Code:\n\n\t**x**\n\ttext") == "Code:\n\n\t**x**\n\ttext"


def test_whole_bold_sentences_are_not_lead_ins() -> None:
    body = "**First sentence. Second sentence.**\nMore."
    assert norm(body) == body
    long = "**" + " ".join(["word"] * 13) + "**\nMore."
    assert norm(long) == long
    assert norm("**Short claim here.**\nMore.") == "**Short claim here.** More."


def test_trailing_punctuation_outside_markers_and_italics() -> None:
    assert norm("**Title**.\ntext") == "**Title.** text"
    assert norm("**Title**:\ntext") == "**Title:** text"
    assert norm("*x*\ntext") == "*x*\ntext"
    assert norm("_x_\ntext") == "_x_\ntext"


def test_idempotent() -> None:
    cases = [
        "***Alpha***\n\nFirst paragraph.\n\n---\n\n***Beta***\n\nSecond paragraph.\n\n---\n",
        "**Architectural Foundations**\nThe socio-computational view.",
        "**Title.** text",
        "**A.**\n\n**B.** text",
        "**Steps**\n- one\n- two\n\nTitle\n---\nText",
    ]
    for body in cases:
        once = norm(body)
        assert norm(once) == once, body


def test_structures_left_untouched() -> None:
    cases = [
        "- **term**: def",
        "1. **First**\n2. **Second**",
        "- a\n  - **nested** bold\n    - **deep**: x",
        "| **a** | b |\n|---|---|\n| 1 | 2 |",
        "a | b\n--- | ---\n1 | 2",
        "$$\n**x**\n---\ny\n$$",
        "\\[\nx = 1\n\\]",
        "Text[^1].\n\n[^1]: A note.",
    ]
    for body in cases:
        assert norm(body) == body, body


def test_unclosed_or_odd_display_math_does_not_swallow_the_body() -> None:
    assert norm("$$\nx = 1\n\n**Sub**\n\nmore\n\n# Head\n\ntext") == "$$\nx = 1\n\n**Sub.** more\n\n**Head.** text"
    assert norm("$$\nx = 1 \\tag{1}\n$$ (1)\n\n**Sub**\ntext") == "$$\nx = 1 \\tag{1}\n$$ (1)\n\n**Sub.** text"
    assert norm("\\[\nx\n\\]\n\n**Sub**\ntext") == "\\[\nx\n\\]\n\n**Sub.** text"
    assert norm("$$\nx\n$$ (1)\n**Sub**\ntext") == "$$\nx\n$$ (1)\n\n**Sub.** text"


def test_title_guard_accepts_abbreviations_rejects_sentences() -> None:
    for title in ("U.S. policy", "Dr. Smith's model", "Methods, e.g. surveys"):
        assert norm(f"**{title}**\ntext") == f"**{title}.** text", title
    body = "**First sentence. Second sentence.**\nMore."
    assert norm(body) == body


def test_front_matter_is_not_a_setext_title() -> None:
    out = norm("---\ntitle: x\n---\nBody.")
    assert "**" not in out and "title: x" in out and out.endswith("Body.")


def test_code_spans_keep_their_markers_in_lead_ins() -> None:
    assert norm("# Use `a**b`\ntext") == "**Use `a**b`.** text"


def test_angle_bracket_text_merges_but_html_does_not() -> None:
    assert norm("**Lead**\n<5% of firms grew.") == "**Lead.** <5% of firms grew."


def test_clean_body_lead_ins_off_for_slides() -> None:
    from engine.assemble.citations import CitationIndex
    from engine.graph.doc_graph import DocGraph
    from engine.pipeline.text import clean_body

    g = DocGraph.new({"title": "B"})
    g.add_node("1", "book", {"title": "S"})
    index = CitationIndex.from_kb_sources({"chunks": []})
    assert clean_body("**Takeaway**\nShort statement.", "S", g, "1", index, lead_ins=False) == "**Takeaway**\nShort statement."
    assert clean_body("**Takeaway**\nShort statement.", "S", g, "1", index) == "**Takeaway.** Short statement."
