# Game engine and SCOWL dictionary

The pure rules engine is shared by the HTTP API and server-side bot. Its dictionary loads a committed local text file; there is no network request or dictionary service during play.

## Dictionary source

- Project: [SCOWL](https://github.com/en-wl/wordlist), release [rel-2026.02.25](https://github.com/en-wl/wordlist/releases/tag/rel-2026.02.25).
- Pinned commit: 7e99edab8e32f9f9ea2b15f249ca8d4d67237410.
- Settings: American English (A), size 60, variant level 1.
- Artifact: data/scowl-en-US-60.txt — **78,659 words**.
- Version: scowl-2026.02.25-en-US-60-v1.
- Full provenance, extraction arguments and SHA-256 checksums: [data/metadata.json](data/metadata.json).
- Upstream notices: [data/SCOWL-Copyright.txt](data/SCOWL-Copyright.txt), also available from the game's instructions.

The upstream metadata filters exclude abbreviation/nonword/word-part categories and named proper-name classes. Only lowercase ASCII alphabetic entries of length 2–49 survive the final filter, BEFORE uppercasing. Accents are removed using SCOWL's deaccent option. Words are sorted and deduplicated. No hand-written additions are merged into this artifact. Size 60 is a general-English list, not the official Letterpress or Scrabble tournament dictionary; dialect and uncommon-word acceptance follow these documented settings.

## Rebuild

Maintainers need Python 3.11+ only when rebuilding, not to run the game. Download the official [source ZIP](https://codeload.github.com/en-wl/wordlist/zip/refs/tags/rel-2026.02.25), then run from the repository root:

~~~sh
python -X utf8 scripts/build_dictionary.py /path/to/source.zip
~~~

The script verifies archive SHA-256 98c973dd3326bbc7aa3373a7e6460065d04ed1f9a57b66dc362f80298fbf6fec, extracts into a temporary directory under .local/, builds the upstream SQLite database, runs upstream extraction, and writes the artifact, metadata, and license copies. It preserves upstream source data without modification. An optional --source-dir path reuses a built source checkout after verifying its source files against the archive. Generated data uses LF line endings on all platforms so checksums remain stable after checkout.

Human validation, bot search and board-quality checks all use the same artifact. Startup verifies its checksum. Bot search caches up to 32 board-letter candidate lists; history restrictions are reapplied on every turn.

## Saved games

Starter dictionary versions authored-en-starter-1 and authored-en-starter-2 upgrade to SCOWL when read, and persist the new version on the next mutation. Existing tiles and accepted history remain unchanged; historical words are not retroactively invalidated. This is a deliberate local-development migration to the user's chosen dictionary.

## Board mix (category-quota-2)

Each new board has rounded quotas of 20% hard letters (X/J/Q/Z), 50% easy letters (A/E/I/L/N/O/R/S/T/U), and the remainder from B/C/D/F/G/H/K/M/P/V/W/Y. Counts are 5/13/7 for 5×5, 7/18/11 for 6×6, and 10/25/14 for 7×7. Hard letters cycle in seeded shuffled order. Easy letters guarantee U, E, T, S and enough vowels for at least 25% of the board. Tile positions are shuffled. Generated and fallback boards have at least 20 constructible dictionary words.

The distribution applies when a lobby starts; already active boards keep their letters. Bots choose uniformly among distinct legal words, then randomly select unused matching tiles without scoring territory. Player credentials use separate cryptographic randomness.

Run npm run test:coverage for engine, dictionary integrity and bot checks. The engine gate requires at least 90% line and branch coverage.
