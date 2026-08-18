# Usage sink providers

A usage sink is where the event log lives. This directory holds the one that ships
with the plugin; a third party writes its own, in its own package, against the same
interface.

The contract is `src/lib/sink/types.ts`, and it is short on purpose: append a batch,
aggregate a window, page through the events behind an aggregate. What an
implementation has to guarantee is written out there, and the four that matter are
append-only storage, at most one row per deduplication key, filtering on event time
rather than ingestion time, and exact integer arithmetic.

## Writing one

```ts
import { ModuleProvider } from "@medusajs/framework/utils"
import { AbstractUsageSinkProviderService } from "@zanreal/medusa-usage/lib/sink/abstract-sink"

class WarehouseUsageSink extends AbstractUsageSinkProviderService {
  static identifier = "warehouse"

  static validateOptions(options) {
    if (!options.endpoint) {
      throw new Error("the warehouse usage sink needs an `endpoint`")
    }
  }

  constructor(container, options) {
    super()
    this.options = options
  }

  async write(events) { /* ... */ }
  async aggregate(query) { /* ... */ }
  async listEvents(query) { /* ... */ }
}

export default ModuleProvider("usage", { services: [WarehouseUsageSink] })
```

Then name it where the plugin is configured:

```ts
plugins: [
  {
    resolve: "@zanreal/medusa-usage",
    options: {
      providers: [
        {
          resolve: "@acme/medusa-usage-warehouse",
          id: "warehouse",
          options: { endpoint: process.env.WAREHOUSE_URL },
        },
      ],
    },
  },
]
```

The `id` is yours, not the provider's. It is what the `sink` option selects on, what
appears in every snapshot, and what a log line names - so two instances of the same
provider package are two sinks with two ids, and they do not collide.

## A worked one

[`@zanreal/medusa-usage-tinybird`](https://github.com/zanreal-labs/medusa-usage-tinybird)
is a sink written against this interface from outside the package. It is the
useful example for the hard part: a column store has no primary key, so "at most
one row per key" is not something the storage gives, and the package sets out
which half of the guarantee it rebuilds in the read path, which half is eventual,
and what that means for a caller reading an aggregate moments after a retry.

Note what it needs from here: the abstract class, the types, and the plugin's own
`canonicalJson` so that a dimension in a filter is encoded exactly as the same
dimension inside a deduplication key. Those imports are why this package emits
declarations.

Learn more about module providers in
[the Medusa documentation](https://docs.medusajs.com/learn/fundamentals/plugins/create).
