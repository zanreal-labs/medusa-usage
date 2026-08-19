import { Button, Table, Text } from "@medusajs/ui";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  const { data, error, isLoading, reload } = request;

  return (
    <Panel
      actions={
        <Button disabled={isLoading} onClick={reload} size="small" variant="secondary">
          {t("usage.common.refresh")}
        </Button>
      }
      description={t("usage.ingestion.description")}
      title={t("usage.ingestion.title")}
    >
      {error ? <Failure message={error} /> : null}
      {isLoading && !data ? <Loading rows={2} /> : null}
      {data ? <Body status={data} /> : null}
    </Panel>
  );
};

const Body = ({ status }: { status: UsageStatusResponse }) => {
  const { t } = useTranslation();

  return (
    <>
      <VerdictLine verdict={readIngestion(t, status)} />
      <div className="grid grid-cols-2 gap-4 px-6 py-4 md:grid-cols-4">
        <Field label={t("usage.ingestion.fields.sink")}>{status.sink}</Field>
        <Field label={t("usage.ingestion.fields.registeredSinks")}>
          {status.sinks.join(", ") || "-"}
        </Field>
        <Field label={t("usage.ingestion.fields.flushMode")}>{status.flush_mode}</Field>
        <Field label={t("usage.ingestion.fields.buffered")}>
          {formatQuantity(status.buffered)}
        </Field>
        <Field label={t("usage.ingestion.fields.oldestBuffered")}>
          {formatDuration(status.oldest_buffered_ms)}
        </Field>
        <Field label={t("usage.ingestion.fields.batchSize")}>
          {formatQuantity(status.batch_size)}
        </Field>
        <Field label={t("usage.ingestion.fields.flushInterval")}>
          {formatDuration(status.flush_interval_ms)}
        </Field>
        <Field label={t("usage.ingestion.fields.lastFlush")}>
          {formatInstant(status.last_flush_at)}
        </Field>
      </div>
      <VerdictLine verdict={readRateCard(t, status)} />
      {status.rates ? <Rates rates={status.rates} /> : null}
    </>
  );
};

const Rates = ({ rates }: { rates: NonNullable<UsageStatusResponse["rates"]> }) => {
  const { t } = useTranslation();

  return (
    <div className="px-6 pb-4">
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("usage.common.meter")}</Table.HeaderCell>
            <Table.HeaderCell>{t("usage.ingestion.rates.price")}</Table.HeaderCell>
            <Table.HeaderCell>{t("usage.ingestion.rates.included")}</Table.HeaderCell>
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
                  {/* `count` picks the plural - English has two forms and Polish
                      has four - while `units` carries the grouped number, which
                      i18next would not group on its own. */}
                  {t("usage.ingestion.rates.perUnit", {
                    count: rate.perUnits,
                    units: formatQuantity(rate.perUnits),
                  })}
                </Text>
              </Table.Cell>
              <Table.Cell>
                {rate.includedUnits > 0
                  ? t("usage.ingestion.rates.free", {
                      units: formatQuantity(rate.includedUnits),
                    })
                  : "-"}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
      {rates.meters.length === 0 ? (
        <Empty title={t("usage.ingestion.rates.emptyTitle")}>
          {t("usage.ingestion.rates.emptyBody")}
        </Empty>
      ) : null}
    </div>
  );
};
