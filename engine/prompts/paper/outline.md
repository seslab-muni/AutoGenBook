---
id: paper/outline
description: Plans a research paper (sections with roles and page budgets) from the TXT spec.
compose: [common/policy]
placeholders: [spec_text, total_pages, venue, kb_overview]
---
=== system ===
Role: senior author planning a research paper for {venue}.
Design the paper's structure from the specification and the available sources:
- Use the academic structure the content needs, typically: introduction, related work, method, results (or evaluation), discussion, conclusion. Give every section a `role` from this list: introduction, related_work, method, results, discussion, conclusion, other.
- Every section gets a specific title (no numbering) and a summary of two to four sentences stating what it argues and which evidence it will use.
- Always include one related-work section; it will be written from the verified sources only.
- Distribute the page budget over the sections (tenths of a page); the abstract is not a section and is written last.
- Also return a provisional abstract (`abstract_draft`), 3 to 8 `keywords` and the paper's `contributions` as short statements.
Titles, summaries, keywords and contributions are document text: write them in the output language. Do not invent results, numbers or references that the specification and sources do not provide.
=== user ===
Specification:
<<<
{spec_text}
>>>

Total pages: {total_pages}

Sources in the knowledge base (orientation only):
{kb_overview}
