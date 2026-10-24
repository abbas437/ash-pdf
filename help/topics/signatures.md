---
id: signatures
title: Sign a document with a saved signature
section: Sign
order: 10
keywords: sign, signature, initials, visual signature, signature block, apply, library, password, lock, digital signature, certificate
---

# Sign a document with a saved signature

> **Important:** ASH PDF Studio places a **visual signature**: an image of your handwriting or name. It is not a digital certificate, it does not prove who signed, and it does not protect the document from later changes.

[Show me the Sign button](#showme:btn:sign)

## Create a signature

1. Choose **Tools ▸ Manage signatures…**, or open the **Sign** menu and choose **Manage signatures…**.
2. Under **Add new:**, choose **Draw…**, **Type…**, **Import image…** or **Paste…**. You can also press <kbd>Ctrl</kbd>+<kbd>V</kbd> in the dialog with an image on the clipboard.
3. Name it, and choose whether it is a **Signature** or **Initials**.
4. Choose **Add to library**.

| Method | What you do |
| --- | --- |
| Draw | Draw on the pad with the mouse, pen or finger; pen colour is dark blue or black |
| Type | Type your name and pick one of four handwriting-style fonts and a colour |
| Import image / Paste | Use a PNG or JPEG; the background is removed |

Saved signatures are kept as an image cropped to the ink. They are protected by your Windows account. To add a password, choose **Lock…** beside the item. A locked signature asks for its password when you use it (once each time the app runs), and a forgotten password cannot be recovered. Use **Remove password…** to unlock it. Signatures saved under another Windows user or computer cannot be opened; create them again. The arrow buttons set the order, and the default one is listed first.

## Place a signature

1. Open the **Sign** button on the toolbar.
2. Choose a saved signature or initials. This arms the placement; click the page to put it there (<kbd>Esc</kbd> cancels).
3. Move or resize it like any object ([Select, group, copy and paste](#topic:select-group-clipboard)).

Other items in the menu:

- **Signature block…** places the signature with a name, an optional title and a date as one group.
- **Place on pages…** (shown in the options bar while a placed signature is selected) copies it to all, odd, even or a range of pages, at the same relative position.
- **Apply signature** fixes the selected signature, with the rest of its block, into the page.

## What Apply signature does

Applying burns the signature into the page content like a wet signature. It then cannot be moved or edited, here or in other viewers, once the file is saved. **Undo** reverses it until you close the file ([Undo and redo](#topic:undo-redo)). If other objects lie under the signature, the confirmation lists them and applies them with it.

Applying asks for confirmation first. To stop that, tick **Don't ask again** in the dialog, or untick **Ask before applying a signature to the page** under Annotations in [Preferences](#topic:preferences). It still asks when the document is already digitally signed, because saving over it invalidates that signature; **Save as** a copy keeps the original intact ([Save and print](#topic:save-and-print)).

> **Tip:** To add a stamp rather than a signature, see [Stamps](#topic:stamps).
