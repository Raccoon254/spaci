# Writing a release with notes, images and a notice

`changelog.json` stays the single source of every release. The fields below
are optional; an entry without them works exactly as before.

## The fields

```json
{
  "version": "2.3.0",
  "date": "2026-10-01",
  "tag": "Latest",
  "major": false,
  "summary": "Spaci now speaks twelve languages.",
  "added": ["Twelve languages, picked in Settings"],
  "improved": [],
  "fixed": [],

  "highlight": "Spaci now speaks your language",
  "notes": "changelog/2.3.0.md",
  "media": [
    { "src": "changelog/media/2.3.0-languages.png", "alt": "The Settings screen with the language picker open", "caption": "Pick a language in Settings" }
  ],
  "links": [
    { "label": "Read the announcement", "url": "https://spaci.kentom.co.ke/blog/spaci-2-3" }
  ],
  "notice": {
    "severity": "update",
    "title": "Spaci 2.3 speaks your language",
    "summary": "Update to use Spaci in one of twelve languages.",
    "cta": { "label": "Get 2.3", "url": "https://spaci.kentom.co.ke/download" },
    "endsInDays": 30
  }
}
```

| Field | Rules |
| --- | --- |
| `highlight` | One line of plain text, at most 160 characters. Leads the What's new screen and the GitHub Release. |
| `notes` | A Markdown file under `changelog/`, usually `changelog/<version>.md`. At most 200 KB. |
| `media` | Up to 12 images: `src` is a file under `changelog/media/` or an https URL on an allowed host; `alt` is required; `caption` is optional. |
| `links` | Up to 20 `{ label, url }`, https only. |
| `notice` | Publishing the release also creates an in-app notice for users on older versions. `severity` is `info`, `update`, `important` or `critical`; `title` (80), `summary` (200), `cta` (https) and `endsInDays` (1 to 365) are optional. |

## Notes Markdown

Write normal Markdown. Headings, paragraphs, lists, quotes, code, images,
bold, italics and links are kept. A `# H1` becomes a level 2 heading (the app
owns the page title). Raw HTML is dropped.

- Images: put them in `changelog/media/` and reference them relative to the
  notes file, for example `![The language picker](media/2.3.0-picker.png)`, so
  GitHub previews them. Alt text is required.
- Links must be `https:` or `mailto:`. Anything else would appear as plain text.

## Images

PNG, JPEG, WebP or GIF, under 3 MB each. SVG is refused (the app never loads
it). The file's bytes are checked, not only its extension. Remote images must
be on `spaci.kentom.co.ke`, `raw.githubusercontent.com/Raccoon254/…` or
`github.com/Raccoon254/…`. `github.com/user-attachments/…` URLs are accepted
by the tooling but redirect to a GitHub storage host the app does not
download from, so prefer a file in `changelog/media/`.

When the release is published, repo-relative images (in `media` and inside the
notes) are rewritten to
`https://raw.githubusercontent.com/Raccoon254/spaci/v<version>/<path>`, which
never changes once the tag exists. `make release` commits the notes file and
every referenced image together with the version bump, so they are in the tag.

## Choosing a notice severity

- `info`: shown in the app only.
- `update` and `important`: also one system notification per user.
- `critical`: cannot be dismissed. Only for a real problem in older versions,
  such as "2.2.x has a bug, update now".

## Checking before you release

```bash
node scripts/release.mjs --check          # validate the newest entry, change nothing
node scripts/release-notes.mjs            # preview the GitHub Release body
```

`make release` runs the same checks and refuses to tag on any error, listing
each problem.
