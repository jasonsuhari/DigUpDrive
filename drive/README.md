# DigUp for Google

A Chrome extension that searches your Google Drive and Gmail by what's in them, with Google DeepMind's
[EmbeddingGemma 2](https://huggingface.co/google/embeddinggemma-2) running in Chrome. It's the
[DigUp](https://github.com/ARahim3/DigUp) search engine brought to the files that live in Google instead of on your disk.

Describe what you're looking for and it takes you to the place, not just the file:

| What you have | Where a result opens |
|---|---|
| Google Docs | the heading, in the right doc tab (`…/edit?tab=t.x#heading=h.y`) |
| Google Sheets | the tab, with the matching rows selected (`#gid=…&range=A101:D126`) |
| Google Slides | the slide (`#slide=id.…`), found by its text, speaker notes or what's in its picture |
| Drawings and pictures | the file, found by what it shows |
| PDFs | the page, in a preview |
| Recordings and videos | the moment, in a preview |
| Word, Excel and PowerPoint files | the file, with the heading, tab and rows, or slide named in the result |
| Gmail | the thread; attachments are searched like Drive files |

## Private

The model runs on your computer, on the graphics card through WebGPU. The index lives in this browser's storage. The
extension talks to Google's APIs (read-only) and to Hugging Face once, to download the model (about 620 MB). Nothing
about your files goes anywhere else.

## Install (developer mode)

```sh
cd drive
npm install
npm run build          # → drive/dist
```

Open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and pick `drive/dist`. The settings page
opens: sign in with Google, choose what to search, and the first pass starts. Then press **⌘⇧Space** (Ctrl+Shift+Space
on Windows and Linux) or type `dig` and a space in the address bar.

The OAuth client in `static/manifest.json` belongs to the `digup-search-ext` Google Cloud project and is in Testing
mode, so only its test users can sign in. To run your own copy, make a Web application OAuth client with the redirect
URI `https://lncdjplbfcdmflkbeimdpikliedjlkkh.chromiumapp.org/` (the ID comes from the `key` in the manifest), turn on
the Drive, Docs, Sheets, Slides and Gmail APIs, and put its client ID in the manifest.

## What it reads

- **Drive**: your files by default; files shared with you and shared drives if you turn them on; or only the folders
  you paste in Settings.
- **Gmail**: messages matching a Gmail search, `newer_than:1y` by default. Each message is one result, and its
  attachments are read like Drive files.
- Google Docs, Sheets and Slides through their APIs; PDFs with pdf.js (a page with little text is read as a picture);
  docx, xlsx and pptx in the browser; pictures, audio (30 s windows every 25 s) and video (a frame every 3 s, one per
  shot, plus the soundtrack) with Chrome's own decoders.
- Exact words count too: names, codes and numbers in file names, document text and email match as written. Text inside
  pictures and scans is found through the model only, by meaning, so a code in a screenshot can rank lower than it
  would with OCR.

It checks Drive's change feed and Gmail's history every 15 minutes, so new files and mail are found without a full
pass.

## Limits

- Files Chrome can't decode are found by name only: HEIC pictures, MPEG-TS video, some audio codecs.
- Audio, video and PDFs over a few hundred MB are found by name only, because the browser reads them whole.
- Forms, Sites and other Google file types are found by name only.
- Drive has no deep links into uploaded Office files, so those open at the start, with the place named in the result.

## Develop

```sh
npm run eval                      # DigUp's evals/synthetic.json through a fake Drive server
node test/eval.mjs ../evals/synthetic.json
node test/google-fixtures.mjs     # sample Docs/Sheets/Slides in a "DigUp test" folder (needs a drive.file token)
node test/live.mjs                # the extension against real Drive and Gmail (needs a read-only token)
```

The tests run the built extension in Chrome for Testing (`npx @puppeteer/browsers install chrome@stable --path
~/.cache/digup-drive-chrome`). `npm run build:test` points the extension at the fake server; `node build.mjs --live`
makes a build that accepts an injected token, so the live test can run without the sign-in window.

On `evals/synthetic.json` (37 queries over pictures, screenshots, PDFs, documents, audio and video) the right answer is
first for 34 and in the top five for 35.
