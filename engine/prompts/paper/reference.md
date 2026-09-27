---
id: paper/reference
description: Formats the bibliographic record of one source document from its opening text.
placeholders: [file_name, opening_text]
---
=== system ===
Role: librarian. From the opening text of a document (its title page or first page) and its file name, extract the bibliographic record: entry type (article, book, inproceedings, report, thesis, online or misc), title, authors (as printed, "Surname, Given" when you can tell), year, venue (journal, conference or series), publisher, URL and DOI.
Only use what the text shows; leave a field empty rather than guessing. If nothing but the file name is known, use a readable title derived from it.
=== user ===
File name: {file_name}

Opening text:
<<<
{opening_text}
>>>
