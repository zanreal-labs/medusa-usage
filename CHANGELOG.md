# Changelog

All notable changes to `@zanreal/medusa-usage` are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). A version
reaches npm only through a GitHub Release, so the dates below are publish dates on the
registry, not merge dates on `main` - see [Releasing](./README.md#releasing).

## [Unreleased]

Nothing yet.

## [0.2.0] - 2026-11-22

### Changed

- **Built and tested against Medusa 2.23.0** (was 2.18.0 in 0.1.1): the `@medusajs/cli`,
  `@medusajs/framework` and `@medusajs/medusa` peers pin 2.23.0, so install this release
  alongside Medusa 2.23.0 and stay on 0.1.1 with older hosts. Medusa 2.23 requires Node.js
  22.22 or newer, and so does this package now.
- **React 19 admin toolchain.** The admin screen is built with React 19, Vite 8 and the i18n
  majors the 2.23.0 dashboard ships (`react-i18next` 18, `i18next` 27); the `react-i18next`
  peer is now `^18.0.1`. Admin extensions share the host's i18n instance, so these follow the
  dashboard rather than moving on their own.
- Dependency updates now come from Renovate, run weekly by the `zanek-ai` app from
  `.github/workflows/renovate.yml`.

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

[Unreleased]: https://github.com/zanreal-labs/medusa-usage/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/zanreal-labs/medusa-usage/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/zanreal-labs/medusa-usage/releases/tag/v0.1.1
[0.1.0]: https://github.com/zanreal-labs/medusa-usage/releases/tag/v0.1.0
