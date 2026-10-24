---
id: edit-text
title: Editing the original text
section: Edit
order: 20
keywords: edit, change, wording, original, line
---

# Editing the original text

The **Edit text** tool changes the words that are already in the document, one line at a time. It rewrites the real text of the page rather than laying a text box on top of it. To add new text, use [text boxes](#topic:text-boxes). To change a word everywhere, see [replace text](#topic:replace-text).

[Show me](#showme:tool:textedit)

## Edit a line

1. Choose **Edit text** on the toolbar, or press <kbd>D</kbd>.
2. Move the pointer over the page. A blue outline appears around the line under the pointer.
3. Click the line. A small editor opens over it, with the word you clicked already selected.
4. Type your changes.
5. Press <kbd>Enter</kbd> or <kbd>Tab</kbd>, or click anywhere else, to apply them. Press <kbd>Esc</kbd> to cancel.

If the text is the same as before (ignoring extra spaces), nothing happens: no undo step is created and the file is not touched.

## Keys in the editor

| Key | Result |
| --- | --- |
| <kbd>Enter</kbd> or <kbd>Tab</kbd> | Apply the change |
| <kbd>Esc</kbd> | Cancel |
| Click outside the editor | Apply the change |
| Switching to another tool | Apply the change |

## Limits

- **One line at a time.** The editor holds a single line. You cannot add a line break or edit a whole paragraph in one go.
- **Locked lines.** A line outlined in red cannot be edited. Hover over the page to see the reason, for example that the line sits inside a form object.
- **Fonts.** The line keeps its font, size and colour. If the font was not fully embedded in the file, a similar substitute is used for that line and you are told which one.
- **Encrypted documents.** Text editing is not available.
- **Unsaved annotations** are left as they are. They are saved with the file in the usual way.

> **Note:** Each applied edit is one step in the undo history. Press <kbd>Ctrl</kbd>+<kbd>Z</kbd> to take it back (see [undo and redo](#topic:undo-redo)).

> **Tip:** Hover before you click. The outline shows exactly which text will change.
