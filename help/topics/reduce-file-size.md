---
id: reduce-file-size
title: Reduce file size
section: Convert and optimise
order: 30
keywords: reduce, compress, optimise, optimize, file size, smaller, images, quality, dpi, shrink
---

# Reduce file size

**Reduce file size…** shrinks a PDF by recompressing its large images and clearing out unused data. Find it under **File ▸ Reduce file size…** or on the **Pages** toolbar menu. [Show me the File menu](#showme:menu:File).

## Steps

1. Open the document and choose **File ▸ Reduce file size…**.
2. Choose a preset. The estimate under **Reduced size** updates after each choice.

| Preset | Images are limited to | JPEG quality |
| --- | --- | --- |
| High quality | 200 dpi | 85% |
| Balanced (default) | 150 dpi | 75% |
| Smallest | 100 dpi | 60% |

3. Compare **Current size** with **Reduced size**. The line below shows how many images were recompressed and how many were left as they are.
4. Click **Save as…** and choose a name. The default is the original name with `-reduced` added.

## What changes

- Large photographic images (RGB or grey JPEG, or plain Flate-compressed) are scaled down and re-encoded as JPEG. An image is replaced only if it becomes at least 5% smaller, and images under 16 KB are left alone.
- Objects that nothing refers to are removed, and the file is saved with object streams.
- Text, vector graphics and page layout are not touched.
- Images with transparency masks, CMYK or indexed colour, and JBIG2, CCITT or JPEG 2000 images are left unchanged.

The open document is never altered. The reduced copy is a new file.

## When it is refused

- **Signed documents:** a message says the document is digitally signed. Rewriting the file would invalidate the signature, so the command is not available.
- **Encrypted (read-only) documents:** "This document is encrypted: it cannot be rewritten."
- **No gain:** if a preset does not make the file smaller, **Save as…** reports "This setting does not make the file smaller. Try a smaller preset."

> **Tip:** A PDF that is mostly text may barely shrink. Scanned files gain most.

> **Note:** JPEG compression is lossy. Keep the original if you may need full image quality later.

Related: [Save and print](#topic:save-and-print), [Recognize text (OCR)](#topic:ocr).
