# Admin extensions

Empty on purpose, for now.

The plugin ships no admin UI in its first release. Everything an operator needs is
on the authenticated admin API - `GET /admin/usage` for what the plugin is doing,
`GET /admin/usage/aggregate` for a snapshot, `GET /admin/usage/events` for the
events behind one - and a screen that only rendered those would be a screen that
had to be redesigned the moment periods and rating exist.

The directory itself has to exist because `medusa plugin:build` writes its admin
entry point into it.

A usage page is a good idea once there is something to put beside the numbers: a
meter to pick, a period to pick, and a reason to look. That is deliberately after
periods, not before them.
