import { Button, Input, Table, Text, Tooltip } from "@medusajs/ui";
import { useMemo, useState } from "react";
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
            placeholder="Another meter name"
            size="small"
            value={draft}
          />
          <Button disabled={!draft.trim()} onClick={add} size="small" variant="secondary">
            Add
          </Button>
        </>
      }
      description={
        subject
          ? `What "${subject}" consumed in the chosen window, meter by meter.`
          : "What every subject together consumed in the chosen window, meter by meter."
      }
      title="Meters"
    >
      {windowError ? <Failure message={windowError} /> : null}
      {!windowError && shown.length === 0 ? (
        <Empty title="No meters to ask about">
          This installation has no rate card, so the plugin does not know which meter names exist -
          it records whatever a producer sends it. Type a meter name above to ask the log what it
          holds for that one.
        </Empty>
      ) : null}
      {!windowError && window && shown.length > 0 ? (
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Meter</Table.HeaderCell>
              <Table.HeaderCell>Quantity</Table.HeaderCell>
              <Table.HeaderCell>Events</Table.HeaderCell>
              <Table.HeaderCell>First</Table.HeaderCell>
              <Table.HeaderCell>Last</Table.HeaderCell>
              <Table.HeaderCell>Digest</Table.HeaderCell>
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
            <Text className="text-ui-fg-subtle" size="small">
              {error ?? "Reading the log..."}
            </Text>
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
                none in this window
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
          Events
        </Button>
      </Table.Cell>
    </Table.Row>
  );
};
