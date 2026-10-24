---
id: undo-redo
title: Undo and redo
section: Getting started
order: 90
keywords: undo, redo, history, ctrl+z, ctrl+y, mistake, page change, text box
---

# Undo and redo

Undo steps back through your changes, annotations and page operations alike, newest first.

## Undo a change

1. Press <kbd>Ctrl</kbd>+<kbd>Z</kbd>, or choose **Edit** ▸ **Undo**.
2. To bring the change back, press <kbd>Ctrl</kbd>+<kbd>Y</kbd> (or <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd>), or choose **Edit** ▸ **Redo**.

The **Undo** and **Redo** buttons on the toolbar do the same.

The menu items and the button tooltips name the step, for example "Undo" followed by what you last did, so you can see what will be reversed. They are greyed out when there is nothing to undo or redo.

> **Note:** Making a new change clears the steps you could have redone.

## Page operations

Rotating, deleting, inserting, reordering and similar page changes are undoable too. After each one a message appears with an **Undo** button. It stays for a few seconds, and only works while that change is still the newest. Annotations on deleted pages come back with the undo.

The app remembers the last 20 page operations per document. Edit ▸ Undo steps through annotation and page changes in the order you made them.

> **Important:** Applying redactions, then saving, clears the earlier page history, because it still holds the content that was removed. Keep a copy first if you may need it.

## Inside a text box

While you are typing in a text box, <kbd>Ctrl</kbd>+<kbd>Z</kbd> and <kbd>Ctrl</kbd>+<kbd>Y</kbd> undo and redo your typing and formatting in that box only. Consecutive typing is grouped. <kbd>Esc</kbd> abandons the edit; <kbd>Ctrl</kbd>+<kbd>Enter</kbd> commits it. See [Text boxes](#topic:text-boxes).

## Closing a document

Undo history is not saved with the file. Save first, and use [Save as](#topic:save-and-print) to keep a version before a large change. See also [Keyboard shortcuts](#topic:keyboard-shortcuts).
