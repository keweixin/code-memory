# Adaptive Output Budget

## Why

Different codebases have very different sizes. A 200-file prototype and a 50,000-file monorepo should not get the same context pack size — too small for the monorepo (the agent gets lost), too big for the prototype (wastes context). The Adaptive Output Budget sizes the output based on the indexed node count.

## The 5 Tiers

| Tier | Threshold | maxOutputChars | maxFiles | maxCharsPerFile | excludeLowValueFiles |
|------|-----------|----------------|----------|-----------------|----------------------|
| tiny | < 500 nodes | 13,000 | 4 | 3,800 | ✅ |
| small | < 2,000 nodes | 18,000 | 5 | 3,800 | ✅ |
| medium | < 10,000 nodes | 28,000 | 10 | 6,500 | ❌ |
| large | < 50,000 nodes | 35,000 | 12 | 7,000 | ❌ |
| huge | ≥ 50,000 nodes | 38,000 | 14 | 7,000 | ❌ |

`nodeCount` = total rows in `files` + total rows in `symbols`.

## What `excludeLowValueFiles` Does

In the `tiny` and `small` tiers, files matching these patterns are filtered out of the "relevant files" list:
- `*.test.*`, `*.spec.*`
- `__tests__/*`, `__mocks__/*`
- paths with `mock`, `fixture`, or `stub` as a path segment

This keeps the focused output on production code rather than test scaffolding.

## Which Tools Use It

- `get_context_pack` — applies `excludeLowValueFiles` + `maxFiles` truncation
- `plan_context` — applies `maxOutputChars` to the plan text
- `explain_module` — applies `maxOutputChars` to the explanation text

## When to Override

If you are working on test code and need to see test files, switch to the `medium` tier or higher by indexing more files (e.g. by including test directories in the scan). You can also pass a higher `tokenBudget` parameter to `get_context_pack` to force more output.
