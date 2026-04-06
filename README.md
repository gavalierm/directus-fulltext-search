# Directus Fulltext Search — Operation Extension

Directus operation extension that builds normalized `fulltext` columns for diacritic-insensitive and case-insensitive search. Replaces the original inline "Run Script" approach with a proper extension.

## How It Works

When a record is created or updated, the operation:

1. Reads `collection` and `keys` from the Flow trigger (or from operation options)
2. Checks if the collection has a `fulltext` column — if not, skips without error
3. Loads the record and resolves all configured data sources (fields, FK relations, M2M relations, transforms, user info)
4. Normalizes everything (NFD decomposition → strip diacritics → lowercase)
5. Joins into a single space-separated string and writes it to the `fulltext` column

## Installation

1. Copy the built extension to the Directus extensions directory:

```
cp -r dist/ <directus>/extensions/operations/fulltext-search/
```

Or symlink the whole package:

```
ln -s /path/to/directus-fulltext-search <directus>/extensions/directus-operation-fulltext-search
```

2. Restart Directus — the operation "Fulltext Search Index" will appear in the Flow editor.

### Build from source

```bash
npm install
npx directus-extension build
```

## Flow Setup

Create a single Flow:

- **Trigger:** Event Hook → Action
- **Scope:** `items.create`, `items.update`
- **Collections:** `songs`, `bands`, `albums`, `setlists`
- **Operation:** "Fulltext Search Index" (type `fulltext-search`)

No operation options are needed — the extension reads `collection` and `keys` from `$trigger` automatically.

### Optional overrides

The operation accepts two optional fields in case you need to override trigger values:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `collection` | `string` | `$trigger.collection` | Collection to process |
| `keys` | `json` (array) | `$trigger.keys` | Array of record IDs to process |

## Inputs

The operation reads from `$trigger` (set by Directus automatically):

```json
{
  "$trigger": {
    "collection": "songs",
    "keys": [42, 43]
  }
}
```

## Output

Returned to the Flow as the operation result:

```json
{
  "updated": 2,
  "collection": "songs",
  "results": [
    { "id": 42, "fulltext": "hallelujah leonard cohen pomale 72 verejne" },
    { "id": 43, "fulltext": "amazing grace john newton stredne 100 verejne" }
  ]
}
```

When skipped (no config, no fulltext column, missing trigger data):

```json
{
  "skip": true,
  "reason": "No fulltext config for collection \"events\""
}
```

## Configured Collections

| Collection | Fields | FK Relations | M2M Relations | Transforms | User |
|------------|--------|-------------|---------------|------------|------|
| `songs` | title, number | band → bands.title, key → scale_keys.label | authors (fullname), translation_authors (fullname) | status, tags, bpm | user_created |
| `bands` | title | — | — | status | — |
| `albums` | title, year | band → bands.title | — | status | — |
| `setlists` | title | band → bands.title | — | status | — |

### Status transform

All collections map the `status` field to Slovak searchable text:

| Value | Fulltext |
|-------|----------|
| `public` | verejne |
| `private` | sukromne |
| `draft` | rozpracovane |
| `unlisted` | nezaradene |
| `archived` | archivovane |

### BPM transform (songs only)

| Range | Fulltext |
|-------|----------|
| < 80 | pomale + numeric value |
| 80–120 | stredne + numeric value |
| > 120 | rychle + numeric value |

### Tags transform (songs only)

JSON array of strings is flattened into space-separated text.

## Logging

The extension only logs on problems — no info-level output on success.

| Level | When |
|-------|------|
| `warn` | Missing trigger data, record not found, FK/M2M lookup failed, no fulltext column, partial update |
| `error` | Schema check failed, record processing crashed |

## Adding a New Collection

1. Add a `fulltext` column (type: Text, hidden, readonly) to the collection in Directus
2. Add a CONFIG entry in `src/api.js`
3. Add the collection to the Flow trigger's collections list
4. Rebuild: `npx directus-extension build`

## Querying

```
GET /items/songs?filter[fulltext][_contains]=ceresna
```

Matches regardless of diacritics or case in the original fields.

## Mass Reindex

The included `reindex-fulltext.py` script PATCHes every record (`title=title`) across all configured collections, which triggers the Flow and rebuilds the fulltext index.

### Requirements

- Python 3
- `requests` (`pip install requests`)
- Optional: `python-dotenv` (`pip install python-dotenv`) for `.env` file support

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DIRECTUS_URL` | yes | Directus instance URL (e.g. `https://your-directus-instance.example.com`) |
| `DIRECTUS_EMAIL` | yes | Admin email for authentication |
| `DIRECTUS_PASSWORD` | yes | Admin password for authentication |

Set them in a `.env` file in the working directory or export them in the shell.

### Usage

```bash
# With .env file in the current directory
python3 reindex-fulltext.py

# Or with inline env vars
DIRECTUS_URL=https://admin.example.com DIRECTUS_EMAIL=admin@example.com DIRECTUS_PASSWORD=secret python3 reindex-fulltext.py
```

The script processes collections in batches of 50 with a 0.5s delay between batches and logs progress to stdout.
