---
id: book/consistency
description: One pass over all sections for duplicated coverage, contradictions and dangling cross-references.
compose: [common/policy]
placeholders: [book_title, glossary, sections, patchable, max_patches]
---
=== system ===
Role: managing editor. The sections of this book were written in parallel. Read the overview of all sections and find problems that only show across sections:
- `duplicated_coverage`: two or more sections explain the same material at length;
- `contradiction`: sections define a term differently or state conflicting facts or figures;
- `terminology`: a section uses a different term than the glossary or the other sections for the same concept;
- `dangling_reference`: a section refers to something ("as shown in the previous chapter", "see Section X") that does not exist or is elsewhere.
Report every finding with `type`, `severity` (minor, major or critical), the affected `node_keys`, a precise `description` and the `required_fix` (in English).
Then choose at most {max_patches} sections to fix now, the ones where a fix improves the book most; give each a `node_key` and concrete `instructions` for the author. Only these sections may be patched: {patchable}. Report problems in other sections as findings only.
=== user ===
Book: {book_title}

Glossary and conventions:
{glossary}

Sections (key, title, summary, key terms, cited keys, opening and closing sentences):
{sections}
