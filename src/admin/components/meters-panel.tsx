import { Button, Input, Table, Text, Tooltip } from "@medusajs/ui";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UsageWindow } from "../lib/api";
import { getAggregate } from "../lib/api";
import { abbreviate, formatInstant, formatQuantity } from "../lib/format";
import { useRequest } from "../lib/use-request";
import { Empty, Failure, Panel } from "./panel";

/**
 * "What did one subject consume?", one meter at a time.
 *
 * Which meters exist is a question the plugin cannot answer, and pretending
 * otherwise would mean adding an endpoint that enumerated the log. So the list is
 * assembled from the two places that honestly know: the rate card, which names
 * every meter this installation prices, and the operator, who can name one it does
 * not. An installation that only meters starts with an empty list and a field, and
 * that is the truthful shape of it rather than a defect.
 *
 * Each meter is its own request. One meter failing is a fact about that meter, and
 * blanking the other rows to report it would hide four working meters to announce
 * one broken one.
 */
export const MetersPanel = ({
  meters,
  onInspect,
  subject,
  window,
  windowError,
}: {
  /** The meters the rate card knows about. */
  meters: string[];
  /** Open the events behind a row. */
  onInspect: (meter: string) => void;
  subject: string;
  window: UsageWindow | null;
  windowError: string | null;
}) => {
  const { t } = useTranslation();
  const [probed, setProbed] = useState<string[]>([]);
  const [draft, setDraft] = useState("");

  const shown = useMemo(
    () => [...new Set([...meters, ...probed])].sort((a, b) => a.localeCompare(b)),
    [meters, probed],
  );

  const add = () => {
    const meter = draft.trim();
    if (meter) {
      setProbed((current) => (current.includes(meter) ? current : [...current, meter]));
      setDraft("");
    }
  };

  return (
    <Panel
      actions={
        <>
          <Input
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                add();
              }
            }}
            placeholder={t("usage.meters.addPlaceholder")}
            size="small"
            value={draft}
          />
          <Button disabled={!draft.trim()} onClick={add} size="small" variant="secondary">
            {t("usage.meters.add")}
          </Button>
        </>
      }
      description={
        // Two whole sentences rather than one with a name spliced in, because the
        // subject sits in a different case in Polish and the sentence around it
        // is not the same sentence.
        subject
          ? t("usage.meters.descriptionSubject", { subject })
          : t("usage.meters.descriptionAll")
      }
      title={t("usage.meters.title")}
    >
      {windowError ? <Failure message={windowError} /> : null}
      {!windowError && shown.length === 0 ? (
        <Empty title={t("usage.meters.emptyTitle")}>{t("usage.meters.emptyBody")}</Empty>
      ) : null}
      {!windowError && window && shown.length > 0 ? (
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t("usage.common.meter")}</Table.HeaderCell>
              <Table.HeaderCell>{t("usage.common.quantity")}</Table.HeaderCell>
              <Table.HeaderCell>{t("usage.common.events")}</Table.HeaderCell>
              <Table.HeaderCell>{t("usage.meters.columns.first")}</Table.HeaderCell>
              <Table.HeaderCell>{t("usage.meters.columns.last")}</Table.HeaderCell>
              <Table.HeaderCell>{t("usage.meters.columns.digest")}</Table.HeaderCell>
              <Table.HeaderCell />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {shown.map((meter) => (
              <MeterRow
                key={meter}
                meter={meter}
                onInspect={onInspect}
                subject={subject}
                window={window}
              />
            ))}
          </Table.Body>
        </Table>
      ) : null}
    </Panel>
  );
};

const MeterRow = ({
  meter,
  onInspect,
  subject,
  window,
}: {
  meter: string;
  onInspect: (meter: string) => void;
  subject: string;
  window: UsageWindow;
}) => {
  const { t } = useTranslation();
  const { data, error, isLoading } = useRequest(
    () => getAggregate({ ...window, meter, subject: subject || null }),
    [meter, subject, window.from, window.to],
  );

  return (
    <Table.Row>
      <Table.Cell>
        <Text as="span" family="mono" size="small">
          {meter}
        </Text>
      </Table.Cell>
      {isLoading || !data ? (
        <>
          <Table.Cell>
            {/* The message goes in a tooltip rather than the cell: an API error is
                a sentence, the column is a number wide, and a clipped explanation
                is worse than a word that promises one. */}
            <Tooltip content={error ?? t("usage.common.readingTheLog")}>
              <Text as="span" className="text-ui-fg-muted" size="small">
                {error ? t("usage.common.unavailable") : "..."}
              </Text>
            </Tooltip>
          </Table.Cell>
          <Table.Cell>-</Table.Cell>
          <Table.Cell>-</Table.Cell>
          <Table.Cell>-</Table.Cell>
          <Table.Cell>-</Table.Cell>
        </>
      ) : (
        <>
          <Table.Cell>{formatQuantity(data.total)}</Table.Cell>
          <Table.Cell>
            {data.eventCount === 0 ? (
              // The distinction the whole screen turns on: nothing was recorded
              // here, which is not the same as nothing working.
              <Text className="text-ui-fg-muted" size="small">
                {t("usage.meters.noneInWindow")}
              </Text>
            ) : (
              formatQuantity(data.eventCount)
            )}
          </Table.Cell>
          <Table.Cell>{formatInstant(data.firstOccurredAt)}</Table.Cell>
          <Table.Cell>{formatInstant(data.lastOccurredAt)}</Table.Cell>
          <Table.Cell>
            <Tooltip content={data.digest}>
              <Text as="span" family="mono" size="xsmall">
                {abbreviate(data.digest)}
              </Text>
            </Tooltip>
          </Table.Cell>
        </>
      )}
      <Table.Cell>
        <Button
          onClick={() => {
            onInspect(meter);
          }}
          size="small"
          variant="transparent"
        >
          {t("usage.common.events")}
        </Button>
      </Table.Cell>
    </Table.Row>
  );
};
