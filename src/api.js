/**
 * Directus Operation — Fulltext Search Index Builder
 *
 * Builds normalized fulltext columns for diacritic-insensitive
 * and case-insensitive search on configured collections.
 *
 * Trigger: items.create + items.update (via Flow event hook)
 * Safety: If the collection has no `fulltext` column, skips gracefully.
 */

// ===== KONFIGURÁCIA =====

// SK↔EN bilingual pairs pre auto-generované tempo/status tokeny.
// Používané pre user tag expanziu — ak operátor manuálne otaguje "slow",
// pridá sa aj "pomale" (a opačne), aby quick filter "Pomalé" našiel pieseň.
const BILINGUAL = new Map([
  ['pomale', 'slow'],          ['slow', 'pomale'],
  ['stredne', 'medium'],       ['medium', 'stredne'],
  ['rychle', 'fast'],          ['fast', 'rychle'],
  ['verejne', 'public'],       ['public', 'verejne'],
  ['sukromne', 'private'],     ['private', 'sukromne'],
  ['rozpracovane', 'draft'],   ['draft', 'rozpracovane'],
  ['nezaradene', 'unlisted'],  ['unlisted', 'nezaradene'],
  ['archivovane', 'archived'], ['archived', 'archivovane'],
]);

const BPM_OVERLAP = 5;

// Zóny tempa s mäkkými hranicami. Boundaries 80 a 120 sú zobrazené explicitne
// s overlap aritmetikou — čitateľnejšie než precomputed 85/75/125/115.
const BPM_MAP = {
  slow:   {                         max: 80 + BPM_OVERLAP,  tokens: 'pomale slow' },
  medium: { min: 80 - BPM_OVERLAP,  max: 120 + BPM_OVERLAP, tokens: 'stredne medium' },
  fast:   { min: 120 - BPM_OVERLAP,                         tokens: 'rychle fast' },
};

const STATUS_MAP = {
  public:   'verejne public',
  private:  'sukromne private',
  draft:    'rozpracovane draft',
  unlisted: 'nezaradene unlisted',
  archived: 'archivovane archived',
};

const CONFIG = {
  songs: {
    fields: ['title', 'number'],
    relations: {
      band: { collection: 'bands', field: 'title' },
      key: { collection: 'scale_keys', field: 'label' },
    },
    m2m: {
      authors: {
        junction: 'songs_authors',
        junctionFK: 'songs_id',
        relatedFK: 'authors_id',
        relatedCollection: 'authors',
        relatedField: 'fullname',
      },
      translation_authors: {
        junction: 'songs_translation_authors',
        junctionFK: 'songs_id',
        relatedFK: 'translation_authors_id',
        relatedCollection: 'translation_authors',
        relatedField: 'fullname',
      },
    },
    transforms: {
      status: STATUS_MAP,
      tags: (value) => {
        if (!Array.isArray(value)) return '';
        const out = new Set();
        for (const tag of value) {
          const norm = normalize(tag);
          if (!norm) continue;
          for (const token of norm.split(/\s+/)) {
            if (!token) continue;
            out.add(token);
            const counterpart = BILINGUAL.get(token);
            if (counterpart) out.add(counterpart);
          }
        }
        return [...out].join(' ');
      },
      bpm: (value) => {
        if (!value) return '';
        const out = new Set();
        for (const zone of Object.values(BPM_MAP)) {
          if (zone.min !== undefined && value < zone.min) continue;
          if (zone.max !== undefined && value > zone.max) continue;
          for (const t of zone.tokens.split(' ')) out.add(t);
        }
        out.add(String(value));
        return [...out].join(' ');
      },
      lyrics: extractLyricsSearchable,
    },
    userCreated: true,
  },
  bands: {
    fields: ['title'],
    transforms: {
      status: STATUS_MAP,
    },
  },
  albums: {
    fields: ['title', 'year'],
    relations: { band: { collection: 'bands', field: 'title' } },
    transforms: {
      status: STATUS_MAP,
    },
  },
  setlists: {
    fields: ['title'],
    relations: { band: { collection: 'bands', field: 'title' } },
    transforms: {
      status: STATUS_MAP,
    },
  },
};

// ===== NORMALIZE =====

// MUST stay behaviorally identical to spevnik/src/lib/api/queries/_search.js#normalize
const DIACRITICS_RE = /[\u0300-\u036f]/g;
const PUNCTUATION_RE = /[\p{P}]+/gu;
const WHITESPACE_RE = /\s+/g;

function normalize(str) {
  if (str == null) return '';
  return String(str)
    .normalize('NFD')
    .replace(DIACRITICS_RE, '')
    .toLowerCase()
    .replace(PUNCTUATION_RE, ' ')
    .replace(WHITESPACE_RE, ' ')
    .trim();
}

// Stripped slug — bez medzier, interpunkcie, špec. znakov.
// Komplementárny variant k normalize() pre name-like fields:
// users hľadajúci "acdc" alebo "imtsmile" nájdu kapelu "AC/DC" / "IMT Smile!".
function slugify(str) {
  if (str == null) return '';
  return String(str)
    .normalize('NFD')
    .replace(DIACRITICS_RE, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Push normalized + slug variant (ak sa líšia) do parts.
// Použité pre name-like fieldy: title, fullname, label.
// NIE pre lyrics (zbytočná expanzia bulk textu) ani auto-generované tokeny.
function pushExpanded(parts, str) {
  const norm = normalize(str);
  if (!norm) return;
  parts.push(norm);
  const slug = slugify(str);
  if (slug && slug !== norm) parts.push(slug);
}

// ===== LYRICS EXTRACTION =====

const VERSE_ALIASES = /^(sloha|verse|vers)(\s*[\w\]]+)?$/i;
const REFRAIN_ALIASES = /^(refren|refrén|chorus)(\s*[\w\]]+)?$/i;
const CHORDS_RE = /\[[^\]]*\]/g;
const MARKERS_RE = /\{[^}]*\}/g;

function extractLyricsSearchable(lyrics) {
  if (!lyrics || typeof lyrics !== 'string') return '';

  const lines = lyrics.split(/\r?\n/);
  const sections = [];
  let current = null;

  for (const line of lines) {
    const headerMatch = line.match(/^#\s*(.+?)\s*$/);
    if (headerMatch) {
      if (current) sections.push(current);
      current = { name: headerMatch[1].trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);

  function firstCleanLine(section) {
    for (const raw of section.lines) {
      const clean = raw
        .replace(CHORDS_RE, '')
        .replace(MARKERS_RE, '')
        .trim();
      if (clean.length >= 3) return clean;
    }
    return '';
  }

  const firstVerse = sections.find((s) => VERSE_ALIASES.test(s.name));
  const firstRefrain = sections.find((s) => REFRAIN_ALIASES.test(s.name));

  const verseLine = firstVerse ? firstCleanLine(firstVerse) : '';
  const refrainLine = firstRefrain ? firstCleanLine(firstRefrain) : '';

  const parts = [];
  if (verseLine) parts.push(verseLine);
  if (refrainLine && normalize(refrainLine) !== normalize(verseLine)) {
    parts.push(refrainLine);
  }

  return parts.join(' ');
}

// ===== HANDLER =====

export default {
  id: 'fulltext-search',
  handler: async (options, { database, logger, data }) => {
    const collection = options.collection || data.$trigger?.collection;
    const keys = options.keys || data.$trigger?.keys || (data.$trigger?.key ? [data.$trigger.key] : []);

    if (!collection) {
      logger.warn('[fulltext] No collection in trigger or options, skipping');
      return { skip: true, reason: 'No collection in trigger or options' };
    }

    if (!keys.length) {
      logger.warn(`[fulltext] No keys in trigger or options for "${collection}", skipping`);
      return { skip: true, reason: 'No keys in trigger or options' };
    }

    const config = CONFIG[collection];
    if (!config) {
      return { skip: true, reason: `No fulltext config for collection "${collection}"` };
    }

    // Check if the collection has a fulltext column
    let hasFulltext;
    try {
      hasFulltext = await database.schema.hasColumn(collection, 'fulltext');
    } catch (err) {
      logger.error(`[fulltext] Schema check failed for "${collection}": ${err.message}`);
      return { skip: true, reason: `Schema check failed: ${err.message}` };
    }

    if (!hasFulltext) {
      logger.warn(`[fulltext] Collection "${collection}" has no fulltext column, skipping`);
      return { skip: true, reason: `Collection "${collection}" has no fulltext column` };
    }

    // Optional: fulltext_title column for title-first ranking (not all deployments
    // may have it yet). If present, we write a normalized title-only index that
    // callers can query before falling back to fulltext.
    let hasFulltextTitle;
    try {
      hasFulltextTitle = await database.schema.hasColumn(collection, 'fulltext_title');
    } catch (err) {
      logger.warn(`[fulltext] fulltext_title schema check failed for "${collection}": ${err.message}`);
      hasFulltextTitle = false;
    }

    const results = [];

    for (const id of keys) {
      try {
        // Build the list of direct fields to select
        const selectFields = [
          ...config.fields,
          ...Object.keys(config.transforms || {}),
          ...Object.keys(config.relations || {}),
        ];

        if (config.userCreated) {
          selectFields.push('user_created');
        }

        const record = await database(collection)
          .where('id', id)
          .select(selectFields)
          .first();

        if (!record) {
          logger.warn(`[fulltext] Record ${id} not found in "${collection}", skipping`);
          continue;
        }

        const parts = [];

        // 1. Direct text fields (name-like → push expanded variant)
        for (const field of config.fields) {
          const value = record[field];
          if (value != null) {
            pushExpanded(parts, value);
          }
        }

        // 2. FK relations (e.g. band → bands.title)
        for (const [fk, rel] of Object.entries(config.relations || {})) {
          const fkValue = record[fk];
          if (fkValue == null) continue;

          const related = await database(rel.collection)
            .where('id', fkValue)
            .select(rel.field)
            .first()
            .catch((err) => {
              logger.warn(`[fulltext] FK lookup failed: ${collection}.${fk} → ${rel.collection}: ${err.message}`);
              return null;
            });

          if (related && related[rel.field] != null) {
            pushExpanded(parts, related[rel.field]);
          }
        }

        // 3. M2M relations (e.g. songs → songs_authors → authors.fullname)
        for (const [name, m2m] of Object.entries(config.m2m || {})) {
          try {
            const junctionRows = await database(m2m.junction)
              .where(m2m.junctionFK, id)
              .select(m2m.relatedFK);

            const relatedIds = junctionRows
              .map((row) => row[m2m.relatedFK])
              .filter(Boolean);

            if (relatedIds.length) {
              const relatedRows = await database(m2m.relatedCollection)
                .whereIn('id', relatedIds)
                .select(m2m.relatedField);

              for (const row of relatedRows) {
                if (row[m2m.relatedField] != null) {
                  pushExpanded(parts, row[m2m.relatedField]);
                }
              }
            }
          } catch (err) {
            logger.warn(`[fulltext] M2M lookup failed for "${name}" on ${collection}#${id}: ${err.message}`);
          }
        }

        // 4. Transforms (status maps, custom functions)
        for (const [field, transform] of Object.entries(config.transforms || {})) {
          const value = record[field];
          if (value == null) continue;

          let text = '';
          if (typeof transform === 'function') {
            text = transform(value);
          } else if (typeof transform === 'object') {
            text = transform[value] || '';
          }

          if (text) {
            parts.push(normalize(text));
          }
        }

        // 5. User created (first_name, last_name)
        if (config.userCreated && record.user_created) {
          const user = await database('directus_users')
            .where('id', record.user_created)
            .select('first_name', 'last_name')
            .first()
            .catch((err) => {
              logger.warn(`[fulltext] User lookup failed for ${record.user_created}: ${err.message}`);
              return null;
            });

          if (user) {
            if (user.first_name) pushExpanded(parts, user.first_name);
            if (user.last_name) pushExpanded(parts, user.last_name);
          }
        }

        // 6. Write fulltext
        // Leading/trailing spaces enable word-boundary _icontains ' token' queries.
        // Dedup tokens (BPM/status/tag bilingual expansions môžu prekrývať user tagy
        // alebo opakované slová v title); zachová word boundaries.
        const tokens = parts.filter(Boolean).join(' ').split(/\s+/).filter(Boolean);
        const fulltext = ' ' + [...new Set(tokens)].join(' ') + ' ';

        // Title-only index (same normalize + word boundary pattern) for title-first
        // ranking. Queried separately by /explore dashboard to prioritize title
        // matches over lyrics/metadata matches at the same LIMIT.
        const update = { fulltext };
        if (hasFulltextTitle) {
          const titleParts = [];
          if (record.title != null) pushExpanded(titleParts, record.title);
          update.fulltext_title = titleParts.length ? ' ' + titleParts.join(' ') + ' ' : '';
        }

        await database(collection).where('id', id).update(update);

        results.push({ id, fulltext });
      } catch (err) {
        logger.error(`[fulltext] Failed to process ${collection}#${id}: ${err.message}`);
      }
    }

    if (results.length < keys.length) {
      logger.warn(`[fulltext] Partial update: ${results.length}/${keys.length} record(s) in "${collection}"`);
    }
    return { updated: results.length, collection, results };
  },
};
