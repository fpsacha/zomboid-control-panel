import '@testing-library/jest-dom'
import './i18n'
import { configure } from '@testing-library/react'

// waitFor()'s own real-wall-clock timeout (@testing-library/dom's
// asyncUtilTimeout, stock default 1000ms) is the sibling vite.config.ts's
// testTimeout=60000 decision missed -- an identical exposure to the same
// CPU contention this floor commonly runs several concurrent agents and
// dev tooling under (see that file's comment for the reproduction), one
// layer down, inside every individual waitFor() call across 12 files and
// 30+ call sites instead of at the whole-test level. This mirrors that
// exact decision rather than adding new slack: a query that never finds
// its target still fails at this ceiling, it just isn't falsely blamed on
// contention first.
//
// bug-hunt-2026-08-26 (client-suite-flaky-one-in-six): demonstrated the
// mechanism directly -- with asyncUtilTimeout set too tight relative to a
// genuine async update, waitFor() produces a completely generic
// "Expected X, Received Y" assertion error with no hint that timing was
// involved, which is why a contention-induced failure's real cause is easy
// to miss. A timeout AFTER this change is a real bug to investigate, never
// something to explain away as "just needs a bigger number."
//
// 2026-09-08 (backups-stale-progress-test-flaky-under-load): that policy is
// still right, but this value being EQUAL to testTimeout has a cost the
// original change didn't anticipate -- when a waitFor()/findBy* condition
// is never met, vitest's own 60000ms ceiling and this one arrive at the
// same instant, and vitest wins the race. The result is a bare "Test timed
// out in 60000ms" with no RTL error naming the query or dumping the DOM --
// exactly what a genuine unmet-condition hang and a load-caused slowdown
// both look like, with nothing in the report to tell them apart. That
// ambiguity is why Backups.staleProgressTimeout.test.tsx's one-time gate
// failure couldn't be diagnosed after the fact: three full-suite
// reproduction attempts and a trace through every candidate for a
// swallowed-error hang came back clean, and the failure itself carried no
// evidence either way.
//
// Kept meaningfully BELOW testTimeout instead: a real unmet condition now
// fails first, with RTL's own diagnostic error and DOM dump, while a bare
// vitest-level timeout past this value means the hang is somewhere that is
// NOT an RTL query -- two distinguishable failure shapes instead of one.
// 45000 is still far more slack than any genuine async update in this
// suite needs; this isn't tightening the ceiling the original comment
// defended, just uncoupling it from testTimeout's.
configure({ asyncUtilTimeout: 45000 })
