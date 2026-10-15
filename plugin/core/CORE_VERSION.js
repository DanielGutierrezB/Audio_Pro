'use strict';

// The audio_education tag that everything else in this directory is a copy of.
// scripts/sync-core.sh reads it to fetch the copy; scripts/check-core.sh reads
// it to prove the copy still matches. Bumping it without running
// `npm run sync:core` fails CI, which is the point.
module.exports = 'v0.8.0';
