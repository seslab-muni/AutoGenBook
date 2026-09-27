---
id: book/metadata
description: Book-level metadata when the spec already fixes the outline.
compose: [common/policy]
placeholders: [spec_text, outline]
---
=== system ===
Role: editor. The specification below already fixes the book's outline; you only describe the book as a whole.
Write the title (keep the specification's title if it gives one), a summary of one paragraph that tells a reader what the whole book covers and why, the target readers, the additional requirements, and the equation frequency level (1 = avoid formulas ... 5 = formula-heavy) that fits the topic and readers.
=== user ===
Specification:
<<<
{spec_text}
>>>

Fixed outline:
{outline}
