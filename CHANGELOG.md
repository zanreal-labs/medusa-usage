# Changelog

All notable changes to `@zanreal/medusa-usage` are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). A version
reaches npm only through a GitHub Release, so the dates below are publish dates on the
registry, not merge dates on `main` - see [Releasing](./README.md#releasing).

## [Unreleased]

Nothing yet.

## [0.1.1] - 2026-09-08

### Changed

- Keywords carry a category word, so the package is eligible for the Medusa
  integrations directory at <https://medusajs.com/integrations>, which is scraped
  from npm. Without it the package could not be picked up at all.

### Added

- This changelog, shipped in the published tarball.

## [0.1.0] - 2026-08-26

First public release. MIT, published from CI with npm provenance.

### Added

- **Append-only usage event log** as a Medusa module, with batched ingestion and
  deterministic deduplication. A retried ingest cannot double count, because the
  deduplication key is derived from the event rather than assigned on arrival.
- **Pluggable event sinks**, so the log can be mirrored into a column store without the
  ingestion path knowing about it. `@zanreal/medusa-usage-tinybird` is the first sink.
- **Billing periods and rating**, ending in a frozen period result: period P, subject S,
  a distribution that no longer moves. The plugin deliberately stops there and does not
  claim to invoice.
- **Admin usage screen**, in English and Polish.
- Builds on `prepare`, so a git dependency resolves without a manual build step.

[Unreleased]: https://github.com/zanreal-labs/medusa-usage/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/zanreal-labs/medusa-usage/releases/tag/v0.1.1
[0.1.0]: https://github.com/zanreal-labs/medusa-usage/releases/tag/v0.1.0
