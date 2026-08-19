import { Button, Table, Text } from "@medusajs/ui";
import type { UsageStatusResponse } from "../lib/api";
import { formatAmount, formatDuration, formatInstant, formatQuantity } from "../lib/format";
import type { Request } from "../lib/use-request";
import { readIngestion, readRateCard } from "../lib/verdicts";
import { Empty, Failure, Field, Loading, Panel, VerdictLine } from "./panel";

/**
 * "Is anything being recorded at all?"
 *
 * The first question an operator arrives with, and until now the one that could
 * only be answered by querying the sink by hand. It is answered here in two parts
 * that are easy to confuse and must not be: whether events are reaching a sink,
 * which is this panel, and whether any usage exists, which is the meters panel
 * below it. A healthy pipe with nothing in it is a normal state, and so is a
 * meter with a total while the buffer is failing to flush.
 *
 * The rate card sits here rather than beside the periods because it is a property
 * of the installation, and because a period that will not close is nearly always a
 * rate card that was never configured.
 */
export const IngestionPanel = ({ request }: { request: Request<UsageStatusResponse> }) => {
  const { data, error, isLoading, reload } = request;

  return (
    <Panel
      actions={
        <Button disabled={isLoading} onClick={reload} size="small" variant="secondary">
          Refresh
        </Button>
      }
      description="What this instance of the plugin is doing with the events it is given."
      title="Ingestion"
    >
      {error ? <Failure message={error} /> : null}
      {isLoading && !data ? <Loading rows={2} /> : null}
      {data ? <Body status={data} /> : null}
    </Panel>
  );
};

const Body = ({ status }: { status: UsageStatusResponse }) => (
  <>
    <VerdictLine verdict={readIngestion(status)} />
    <div className="grid grid-cols-2 gap-4 px-6 py-4 md:grid-cols-4">
      <Field label="Sink">{status.sink}</Field>
      <Field label="Registered sinks">{status.sinks.join(", ") || "-"}</Field>
      <Field label="Flush mode">{status.flush_mode}</Field>
      <Field label="Buffered">{formatQuantity(status.buffered)}</Field>
      <Field label="Oldest buffered">{formatDuration(status.oldest_buffered_ms)}</Field>
      <Field label="Batch size">{formatQuantity(status.batch_size)}</Field>
      <Field label="Flush interval">{formatDuration(status.flush_interval_ms)}</Field>
      <Field label="Last flush">{formatInstant(status.last_flush_at)}</Field>
    </div>
    <VerdictLine verdict={readRateCard(status)} />
    {status.rates ? <Rates rates={status.rates} /> : null}
  </>
);

const Rates = ({ rates }: { rates: NonNullable<UsageStatusResponse["rates"]> }) => (
  <div className="px-6 pb-4">
    <Table>
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>Meter</Table.HeaderCell>
          <Table.HeaderCell>Price</Table.HeaderCell>
          <Table.HeaderCell>Included</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {rates.meters.map((rate) => (
          <Table.Row key={rate.meter}>
            <Table.Cell>
              <Text as="span" family="mono" size="small">
                {rate.meter}
              </Text>
            </Table.Cell>
            <Table.Cell>
              {formatAmount(rate.unitAmount, rates.currency)}
              <Text as="span" className="text-ui-fg-subtle" size="small">
                {rate.perUnits === 1 ? " per unit" : ` per ${formatQuantity(rate.perUnits)} units`}
              </Text>
            </Table.Cell>
            <Table.Cell>
              {rate.includedUnits > 0 ? `${formatQuantity(rate.includedUnits)} free` : "-"}
            </Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
    {rates.meters.length === 0 ? (
      <Empty title="The rate card prices no meters">
        A rate card with no meters rates every period at zero. That is a valid answer and a
        surprising invoice, so it is worth checking that it was the intended one.
      </Empty>
    ) : null}
  </div>
);
