---
id: troubleshooting
title: Troubleshooting
section: About
order: 20
keywords: problem, error, encrypted, read-only, signed, Office, slow, OCR, question mark, settings, portable, report
---

# Troubleshooting

### Why can't I edit or save an encrypted file?

A password-protected PDF opens after you enter the password, but it opens as read-only. Text editing, redaction, OCR and Reduce file size are not available for it. To edit it, remove the protection in the program that created the file, then open the new copy.

### What happens when I save a digitally signed file?

If you only added annotations, the app appends them to the file and keeps the original signed bytes. After a page operation, or for a file certified against changes, saving would rewrite the file and break the signature. You are asked first. Choose **Save As** to keep the signed original untouched. Reduce file size is not available for signed documents. See [Signatures](#topic:signatures) and [Save and print](#topic:save-and-print).

### Why are Export to Word and Create PDF from Office limited?

The Microsoft Office engine needs Microsoft Office installed on Windows. Without it, only the built-in engine is offered. That engine converts .docx and .xlsx files; older .xls, .doc and PowerPoint files need Office. See [Create PDF from Office](#topic:create-pdf-from-office) and [Export to Word, Excel or an image](#topic:export-word-excel-image).

### Why is a large file slow?

Try **File ▸ Reduce file size…** to save a smaller copy; see [Reduce file size](#topic:reduce-file-size). If scrolling is still slow, close the **Thumbnails** tab in the sidebar so fewer pages are drawn.

### Why can't I select the text?

The page is probably a scan, which is only a picture. Run **Tools ▸ Recognize text (OCR)…** to add a text layer. See [Recognise text (OCR)](#topic:ocr).

### Why do some characters show as "?" in a text box?

The text box uses the standard PDF fonts, which hold only the Western (WinAnsi) character set. While you type, a warning says: "Some characters cannot be saved with the standard PDF fonts and will appear as "?"." Remove or replace those characters.

### Where are my settings kept?

The portable version keeps them in an `ASH-PDF-Studio-data` folder next to the .exe, and leaves nothing else on the PC. Copy that folder to move your settings. Saved signatures are tied to your Windows account, so re-create them on another PC. See [Preferences](#topic:preferences).

### How do I report a problem?

Open an issue at [github.com/abbas437/ash-pdf/issues](https://github.com/abbas437/ash-pdf/issues), or contact us through [ashdesignsuite.com](https://ashdesignsuite.com). Say which version you use, what you did, and what you expected.

> **Tip:** Attach a small PDF that shows the problem, if it contains nothing private.
