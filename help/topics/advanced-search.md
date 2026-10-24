---
id: advanced-search
title: Advanced Search
section: Find
order: 20
keywords: advanced search, folder, index, regular expression, regex, stemming, proximity, email, phone, date, URL, amount, comments, bookmarks, CSV, export
---

# Advanced Search

Advanced Search looks through the current document, all open documents or a whole folder of PDFs, and groups the results by file. For a quick search of one document, use the [find bar](#topic:find-and-search) instead.

## Open it

Choose Edit ▸ Advanced Search… or press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd>. The **Advanced search** tab opens in the sidebar with the cursor in the search box.

## Run a search

1. Choose a **Scope**: *Current document*, *All open documents* or *Folder…*.
2. For a folder, click **Choose folder…**. Tick **Include subfolders** to search the folders inside it.
3. Type your text in **Search for…** and choose how to **Match** it.
4. Click **Search** (or press <kbd>Enter</kbd>). A progress bar shows the file being read. Click **Cancel** to stop; the hits found so far stay on screen.

## Options

| Option | What it does |
| --- | --- |
| **Match: Exact phrase** | Finds the words together, in order |
| **Match: All words** | Finds places where every word appears |
| **Match: Any words** | Finds places where at least one word appears |
| **Case sensitive** | Matches capitalisation exactly |
| **Whole words** | Ignores matches inside longer words |
| **Stemming** | Treats word endings as equal, so "pump" also finds "pumps" and "pumping" |
| **Regular expression** | Reads the search box as a regular expression |
| **Within N words** | With *All words*, only counts hits where the words are within N words of each other (1 to 1000) |
| **Pattern** | Ignores the search box and finds a common kind of text: Email, Phone, Date, URL, Amount or Custom regex |
| **Comments** | Also searches the text of comments saved in the file |
| **Bookmarks** | Also searches bookmark titles |

When you choose **Custom regex** in Pattern, type your expression in the **Custom regular expression** box that appears.

> **Note:** Comments you have added but not yet saved are not in the file, so they are not searched. Save first.

## Folders and the index

Large folders can take a while to read. Tick **Use index** to search a saved index instead. Click **Build/Update index** to create it; later updates re-read only the files that have changed. If you tick **Use index** before building one, you will be asked to build it first.

## Work with the results

- Results are grouped by file, with the number of hits beside each name. Comment and bookmark hits are labelled.
- Use **Sort by** to order files by *File name*, *Modified date* or *Hits*.
- Click a hit to open that file (if it is not already open) at the right page. Text hits are highlighted.
- The panel shows up to 5,000 hits. If there are more, the status line says so.
- Click **Export CSV** to save every hit to a file named `search-results.csv`, including any beyond the 5,000 shown.

> **Tip:** To remove what you find, use **Mark all for redaction** from the find bar. See [Redaction](#topic:redaction). Every shortcut is listed under [Keyboard shortcuts](#topic:keyboard-shortcuts).
