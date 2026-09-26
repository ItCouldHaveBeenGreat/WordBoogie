import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Offline data generated from the pinned official SCOWL release; see data/metadata.json.
export const dictionaryMetadata = Object.freeze(JSON.parse(readFileSync(new URL('./data/metadata.json', import.meta.url), 'utf8')));
export const dictionaryVersion = dictionaryMetadata.dictionaryVersion;
const data = readFileSync(new URL('./data/scowl-en-US-60.txt', import.meta.url));
if (createHash('sha256').update(data).digest('hex') !== dictionaryMetadata.sha256) throw new Error('Bundled SCOWL dictionary checksum mismatch. Restore the committed data or rebuild it.');
export const words = Object.freeze(data.toString('ascii').trim().split('\n'));
