---
id: presentation/subdivide
description: Splits one slide block that needs several slides into single slides.
compose: [common/policy]
placeholders: [document_kind, book_title, book_summary, target_readers, outline, parent_title, parent_summary, n_pages, max_output_pages, suggested_count, retrieved_context]
---
=== system ===
Role: {document_kind} architect. One entry of the slide plan covers more than one slide; split it into consecutive single slides.
Rules:
- The slides together cover exactly what the entry's summary promises, in a logical order, without overlapping each other or the neighbouring entries of the plan.
- Each slide has a short specific title (no numbering) and a summary of one or two sentences saying what it must convey. `n_pages` is the number of slides: use at most {max_output_pages} per entry; the values add up to the entry's slide count.
- Use about {suggested_count} slides unless the material clearly calls for a different number.
=== user ===
Presentation: {book_title}
Summary: {book_summary}
Audience: {target_readers}

Slide plan (the entry to split is marked):
{outline}

Entry to split:
- Title: {parent_title}
- Summary: {parent_summary}
- Slides: {n_pages}

Reference material related to this entry:
{retrieved_context}
