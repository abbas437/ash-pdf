---
id: redaction
title: Whiteout and redaction
section: Edit
order: 40
keywords: redact, whiteout, black out, remove, confidential, hide, metadata
---

# Whiteout and redaction

Two tools hide content, and they are not the same.

| Tool | Key | What it does |
| --- | --- | --- |
| **Whiteout** | <kbd>W</kbd> | Covers an area with white. It does **not** remove what is underneath. |
| **Redact** | <kbd>X</kbd> | Marks an area to be removed. Nothing is removed until you apply the redactions. |

> **Important:** Whiteout only covers. The text or image under it is still in the file and can be copied or recovered. To remove content for good, use Redact.

## Redact content

1. Choose **Redact: mark areas to remove**, or press <kbd>X</kbd>. [Show me](#showme:tool:redact)
2. Drag a rectangle over each area to remove. Each one becomes a mark you can still move or delete.
3. Click **Apply redactions…** in the options bar, or choose **Document ▸ Apply redactions…**.
4. Choose how to fill the areas: **Black**, **White** or **None**.
5. Tick **Also remove document metadata** if you want the title, author, subject, keywords and XMP data cleared too.
6. Click **Apply**.

Text, image pixels, vector shapes and annotations under the marks are removed, as are typed form values and unsaved annotations in those areas.

## Mark every search result

To redact a word or phrase wherever it appears, search for it (see [find and search](#topic:find-and-search)), then click **Mark all for redaction** in the results list. Each hit becomes a mark in one undoable step. You still have to apply the redactions.

## Before you apply

- The dialog tells you how many marks there are and on how many pages.
- If the file has digital signatures, a warning says they will become invalid.
- Encrypted documents cannot be redacted.
- With no marks, nothing happens.

> **Important:** Redaction is permanent once you save. You can undo until then (see [undo and redo](#topic:undo-redo)). The next save rewrites the whole file, so the old content is not left behind.

> **Tip:** Use **Document ▸ Apply redactions…** only after checking each mark. Zoom in to make sure the whole word is covered.
