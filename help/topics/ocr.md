---
id: ocr
title: Recognize text (OCR)
section: Convert and optimise
order: 40
keywords: ocr, recognize text, scanned, scan, searchable, text layer, copy text, tesseract, english
---

# Recognize text (OCR)

A scanned page is only a picture. **Tools ▸ Recognize text (OCR)…** reads the words in it and adds them as an invisible text layer, so you can search and copy the text. The page looks exactly the same. [Show me the Tools menu](#showme:menu:Tools).

## Steps

1. Open the scanned PDF and choose **Tools ▸ Recognize text (OCR)…**.
2. Choose the pages: **Current page**, **All pages**, or **Pages** with a range such as `1-3, 7`.
3. Leave **Skip pages that already contain text** ticked to save time, or clear it to read every chosen page.
4. Click **Recognize**. A progress window shows "Recognizing page 2 of 10…" with a Cancel button.
5. When it finishes, a message reports how many words were found on how many pages. Use [Find and search](#topic:find-and-search) to check.

The result is one undoable page operation. Save the document to keep it.

## The scanned-document banner

When you open a document whose first three pages have no text and are mostly covered by images, a bar says "This looks like a scanned document." Click **Recognize text** to open the dialog with **All pages** selected, or **Not now** to dismiss it. It shows once per document per session, and not for read-only documents.

To turn it off, clear **Offer to recognize text when a scanned document opens** under **Edit ▸ Preferences… ▸ Documents**. See [Preferences](#topic:preferences).

## Limits

| Item | Detail |
| --- | --- |
| Language | English only |
| Internet | Not needed; the engine is built in |
| Resolution | Pages are read at 300 dpi, lower for very large sheets |
| Speed | Runs on your computer, page by page; long documents take a while |
| Memory | About 100 MB while it runs |

> **Note:** Handwriting, low-quality scans and non-English text give poor results. Characters outside the basic Western set may appear as `?` in the hidden layer.

> **Important:** The command is unavailable for encrypted (read-only) documents. If the engine files are missing, "Text recognition is not available" appears; reinstall the application.

If nothing is found you see "No text was recognized". If the pages already have text you see "All the selected pages already contain text".
