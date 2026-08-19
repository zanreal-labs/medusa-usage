import { Button, Select, StatusBadge, Table, Text } from "@medusajs/ui";
import { useState } from "react";
import type { PeriodRow, UsageStatusResponse } from "../lib/api";
import { listPeriods } from "../lib/api";
import { formatInstant } from "../lib/format";
import { useRequest } from "../lib/use-request";
import { readClosability } from "../lib/verdicts";
import { Empty, Failure, Loading, Panel } from "./panel";

/** Periods per request. The route's own default. */
const PAGE_SIZE = 50;

/**
 * "Is this period closed, and can it be?"
 *
 * The list is the one a billing run makes, with the filter it uses: `open` is
 * exactly the set that has not been billed, because a period is closed when and
 * only when it has a frozen result - there is no status column that could disagree
 * with one.
 *
 * The closability column is the part worth having. Before this screen, a period
 * that could not be closed announced itself as a rejected request in the middle of
 * a billing run; here it is visible beforehand, with the reason.
 */
export const PeriodsPanel = ({
  onSelect,
  rates,
  refreshToken,
  subject,
}: {
  onSelect: (id: string) => void;
  /** `undefined` while the status is still being read. */
  rates: UsageStatusResponse["rates"] | undefined;
  /** Bumped by the page after a close, so the list reflects it. */
  refreshToken: number;
  subject: string;
}) => {
  // "any" rather than "" because a Radix select item cannot carry an empty
  // value, and the API wants the parameter absent rather than blank.
  const [status, setStatus] = useState<"any" | "closed" | "open">("any");
  const request = useRequest(
    () =>
      listPeriods({
        limit: PAGE_SIZE,
        status: status === "any" ? "" : status,
        subject: subject || null,
      }),
    [status, subject, refreshToken],
  );
  const periods = request.data?.periods ?? [];
  const filtered = Boolean(subject) || status !== "any";

  return (
    <Panel
      actions={
        <>
          <Select
            onValueChange={(value) => {
              setStatus(value as "any" | "closed" | "open");
            }}
            size="small"
            value={status}
          >
            <Select.Trigger className="min-w-40">
              <Select.Value placeholder="Any status" />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="any">Any status</Select.Item>
              <Select.Item value="open">Open, not billed</Select.Item>
              <Select.Item value="closed">Closed</Select.Item>
            </Select.Content>
          </Select>
          <Button disabled={request.isLoading} onClick={request.reload} size="small" variant="secondary">
            Refresh
          </Button>
        </>
      }
      description={
        // The subject filter applies here; the dates above do not. A period is
        // billed on its own boundaries, and hiding one because it falls outside a
        // window someone picked for a different question would be the worst kind of
        // helpful.
        subject
          ? `Periods for "${subject}", newest window first. A period is closed when, and only when, it has a frozen result. The dates above do not filter this list.`
          : "Newest window first. A period is closed when, and only when, it has a frozen result. The dates above do not filter this list."
      }
      title="Billing periods"
    >
      {request.error ? <Failure message={request.error} /> : null}
      {request.isLoading && !request.data ? <Loading /> : null}
      {request.data && periods.length === 0 ? <PeriodsEmpty filtered={filtered} /> : null}
      {periods.length > 0 ? (
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Subject</Table.HeaderCell>
              <Table.HeaderCell>Window</Table.HeaderCell>
              <Table.HeaderCell>Status</Table.HeaderCell>
              <Table.HeaderCell>Closable</Table.HeaderCell>
              <Table.HeaderCell />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {periods.map((period) => (
              <PeriodRowView key={period.id} onSelect={onSelect} period={period} rates={rates} />
            ))}
          </Table.Body>
        </Table>
      ) : null}
    </Panel>
  );
};

const PeriodRowView = ({
  onSelect,
  period,
  rates,
}: {
  onSelect: (id: string) => void;
  period: PeriodRow;
  rates: UsageStatusResponse["rates"] | undefined;
}) => {
  const closability = readClosability(period, rates, new Date());

  return (
    <Table.Row>
      <Table.Cell>
        <Text as="span" family="mono" size="small">
          {period.subject}
        </Text>
      </Table.Cell>
      <Table.Cell>
        {formatInstant(period.starts_at)} to {formatInstant(period.ends_at)}
      </Table.Cell>
      <Table.Cell>
        <StatusBadge color={period.closed_at ? "green" : "grey"}>
          {period.closed_at ? "Closed" : "Open"}
        </StatusBadge>
      </Table.Cell>
      <Table.Cell>
        <Text className="text-ui-fg-subtle" size="small">
          {SHORT_REASON[closability.state]}
        </Text>
      </Table.Cell>
      <Table.Cell>
        <Button
          onClick={() => {
            onSelect(period.id);
          }}
          size="small"
          variant="transparent"
        >
          Open
        </Button>
      </Table.Cell>
    </Table.Row>
  );
};

/** The column is a glance; the drawer carries the reason in full. */
const SHORT_REASON: Record<ReturnType<typeof readClosability>["state"], string> = {
  closable: "Ready to close",
  closed: "Already closed",
  "no-rate-card": "No rate card",
  "too-early": "Still accruing",
  unknown: "-",
};

/**
 * Exported so the copy can be asserted. On a fresh installation this is the whole
 * panel, and the difference between "nothing has happened yet" and "something is
 * broken" is the only thing it has to get right.
 */
export const PeriodsEmpty = ({ filtered }: { filtered: boolean }) =>
  filtered ? (
    <Empty title="No periods match these filters">
      Clear the subject, or set the status back to any, to see whether there are periods that do
      not match rather than none at all.
    </Empty>
  ) : (
    <Empty title="No periods have been opened">
      This is the expected state on a new installation, and it is not a fault. The plugin does not
      create periods, because only the application knows what a billing cycle is here - whether it
      is a calendar month, thirty days from the day someone signed up, or something else. Open one
      with `POST /admin/usage/periods`, from a job of your own, and it will appear in this list.
    </Empty>
  );
