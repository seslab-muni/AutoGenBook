---
id: common/citations
description: Citation rules composed into prompts that write document text.
placeholders: []
---
Citations:
- Retrieved excerpts are shown as `[<RID>] kind=... source="..." loc="..." cite_key="<key>"` followed by the excerpt text.
- Cite a supported statement by writing the excerpt's key in square brackets right after the statement, for example `... as the report shows [kb_report_ab12cd34_page_3_1].` Several sources: one bracket per key, `[key_one] [key_two]`.
- Use only keys that appear in the retrieved excerpts you were given. Never make up a key, never cite a source you were not shown, and never use LaTeX `\cite{{}}` or footnotes.
- Cite where it matters (definitions, facts, figures, claims that a reader may want to check), not after every sentence.
