# Admin extensions

One route: **Usage**, at `/app/usage`, with its own sidebar entry.

The plugin shipped no admin UI in its first release, on the grounds that a screen
which only rendered the endpoints of the day would have to be redesigned the moment
periods and rating existed. Periods, rating and the frozen period result exist now,
so there is a meter to pick, a period to pick, and a reason to look.

## What it answers

Three questions, and deliberately nothing else. They are the three an operator
actually arrives with, and each one used to require a query against the sink.

1. **Is anything being recorded at all?** The ingestion panel reads
   `GET /admin/usage` and says whether events are reaching a sink; the meters panel
   asks `GET /admin/usage/aggregate` per meter and says whether any usage exists.
   Those are different questions and the screen keeps them apart: a healthy pipe
   with nothing in it is a normal state, and so is a meter with a total while the
   buffer is failing to flush.
2. **What did one subject consume in one window?** A subject and a half-open UTC
   window at the top, then a row per meter with the quantity, the event count and
   the snapshot digest. `Events` on a row opens the individual events the total was
   summed from, from `GET /admin/usage/events` - the audit path, and the thing to
   show someone who disputes a number.
3. **Is this period closed, can it be, and does it verify?** The periods panel
   lists what `GET /admin/usage/periods` returns and, for each open period, whether
   it can be closed yet. Opening one shows the frozen result with its digest, and
   offers `close` behind a confirmation and `verify` without one.

## What it deliberately does not do

- **No charts.** A chart answers a question nobody arrived with, and answering it
  quickly would need a rollup this package does not have.
- **No money or quantities computed here.** Every total, amount and count is
  rendered exactly as the API sent it. Amounts are converted from whole minor
  currency units by moving the decimal point through the digit string, never by
  dividing, so a figure here cannot drift from the figure that was billed. The one
  thing the screen does compute is `ends_at + closeDelayMs`, to say why a period is
  not closable yet - the server enforces that rule regardless, and its answer is
  the one that counts.
- **No endpoint of its own.** Everything comes from the authenticated admin API
  the plugin already ships. If the screen ever appears to need a new route, that is
  a signal about the API rather than about the screen.
- **No opening of periods.** Which periods exist, and when, is the one thing a
  package that does not know your billing cycle cannot decide. The screen says so
  where the list is empty, and points at `POST /admin/usage/periods`.
- **No meter discovery.** The plugin records whatever meter name a producer sends
  and keeps no registry of them, so the list is assembled from the rate card plus
  whatever an operator types in. An installation that only meters starts with an
  empty list and a field, which is the truthful shape of it.

## Layout

```
lib/          The API client and its wire types, formatting, window resolution,
              the verdicts that turn a response into the sentence the screen
              shows, and one request hook. `format`, `window` and `verdicts` are
              pure and unit tested; `api`, `sdk` and `use-request` are the seam
              to the network and are not.
components/   The panels and drawers. No state beyond what is on screen. Their
              empty states are asserted in `empty-states.test.tsx`.
routes/usage/ page.tsx - the route itself, and the only state that spans panels.
```

`lib/verdicts.ts` is where the judgements live, out of the components, so they are
testable without a browser and cannot quietly disagree with each other.
`readClosability` reproduces the rule `assertClosable` enforces on the server, so
the screen can explain why a period is not closable yet instead of offering a
button that returns an error.

## Typechecking

The admin extensions are built by Vite, not by the server `tsconfig.json`, which
excludes `src/admin` for that reason. They have their own `tsconfig.json` here, and
`pnpm check` runs both.
