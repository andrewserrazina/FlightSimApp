# SimBrief fixtures (synthetic, sanitized)

Offline test inputs for the SimBrief import (`apps/desktop/test/dispatch*.test.ts*`). **No real flight plan, account
or person is represented.** Pilot IDs (`000001`, `000002`), OFP ids (`9000000xx`), the airline `TLN` and the
registration `N247TL` are fictional, and links point at `example.invalid`.

| File | What it models |
|---|---|
| `ofp-v2-kgs.json` | `json=v2` OFP in kilograms with every field Turnline reads (A20N KBOS→KORD) |
| `ofp-v2-lbs.json` | The same route in pounds (B738): empty values encoded as `{}`, alternate as an array, cost index `AUTO` |
| `ofp-v2-iso-times.json` | The kg OFP with times in the ISO-8601 / `HH:MM:SS` form seen in a real OFP, plus `est_out/off/on/in` that differ from the scheduled landing and on-block |
| `ofp-v2-sparse.json` | Missing units, schedule and alternate; malformed numbers; an implausible timestamp |
| `error-unknown-user.json` | The exact HTTP 400 body SimBrief returned for a non-existent username (`turnline_nonexistent_test_user_000`), captured 2026-10-15 |

The field names follow SimBrief's documented OFP variables. The first real-account test (2026-10-15) confirmed the import works end-to-end; schedule times
are accepted both as Unix seconds and as ISO-8601 because real OFPs have been seen in both forms (see
`docs/dispatch/simbrief-import.md`).
