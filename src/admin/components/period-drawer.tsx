import { Button, Drawer, Table, Text, Tooltip, usePrompt } from "@medusajs/ui";
import { useState } from "react";
import type { PeriodResult, PeriodVerification } from "../../lib/billing/result";
import type { PeriodRow, UsageStatusResponse, UsageWindow } from "../lib/api";
import { closePeriod, getAggregate, getPeriod, verifyPeriod } from "../lib/api";
import { formatAmount, formatAmountDelta, formatDelta, formatInstant, formatQuantity } from "../lib/format";
import type { Request } from "../lib/use-request";
import { messageOf, useRequest } from "../lib/use-request";
import { periodWindow } from "../lib/window";
import { readClosability, readVerification } from "../lib/verdicts";
import { Empty, Failure, Field, Loading, VerdictLine } from "./panel";

/**
 * One period, and the two things that can be done to it.
 *
 * Closing is where money starts existing, so it is behind a confirmation and it
 * says what it will do first: the rate card it will use, the window it will rate,
 * and the fact that it is safe to retry. Verifying is free and changes nothing, so
 * it is a button with no ceremony at all.
 *
 * The frozen result is rendered exactly as it was stored, digest included. That
 * digest is the point of the panel: it is what a host compared against when it
 * raised the invoice, and it is what makes "prove this number" a thing an operator
 * can answer here rather than from a database.
 */
export const PeriodDrawer = ({
  onClose,
  onClosed,
  periodId,
  status,
}: {
  onClose: () => void;
  /** Told after a real close, so the rest of the screen stops calling it open. */
  onClosed: () => void;
  periodId: string | null;
  /** The whole request: an unread rate card and an unreadable one differ. */
  status: Request<UsageStatusResponse>;
}) => (
  <Drawer
    onOpenChange={(open) => {
      if (!open) {
        onClose();
      }
    }}
    open={periodId !== null}
  >
    <Drawer.Content>
      <Drawer.Header>
        <Drawer.Title>Billing period</Drawer.Title>
        <Drawer.Description>{periodId ?? ""}</Drawer.Description>
      </Drawer.Header>
      <Drawer.Body className="overflow-y-auto">
        {periodId ? <Detail onClosed={onClosed} periodId={periodId} status={status} /> : null}
      </Drawer.Body>
    </Drawer.Content>
  </Drawer>
);

const Detail = ({
  onClosed,
  periodId,
  status,
}: {
  onClosed: () => void;
  periodId: string;
  status: Request<UsageStatusResponse>;
}) => {
  const prompt = usePrompt();
  const request = useRequest(() => getPeriod(periodId), [periodId]);
  const [action, setAction] = useState<{ error: string | null; isBusy: boolean }>({
    error: null,
    isBusy: false,
  });
  const [verification, setVerification] = useState<PeriodVerification | null>(null);

  if (request.error) {
    return <Failure message={request.error} />;
  }
  if (!request.data) {
    return <Loading rows={6} />;
  }

  const { period, result } = request.data;
  const closability = readClosability(period, status.data?.rates, new Date());

  const close = async () => {
    const confirmed = await prompt({
      cancelText: "Cancel",
      confirmText: "Close period",
      description: `This rates ${period.subject} over ${formatInstant(period.starts_at)} to ${formatInstant(period.ends_at)} against the current rate card and freezes the answer. It is safe to retry and cannot bill the same period twice, but the frozen result does not move afterwards.`,
      title: "Close this period?",
      variant: "confirmation",
    });
    if (!confirmed) {
      return;
    }

    setAction({ error: null, isBusy: true });
    try {
      await closePeriod(period.id);
      setVerification(null);
      setAction({ error: null, isBusy: false });
      request.reload();
      onClosed();
    } catch (failure: unknown) {
      setAction({ error: messageOf(failure), isBusy: false });
    }
  };

  const verify = async () => {
    setAction({ error: null, isBusy: true });
    try {
      setVerification(await verifyPeriod(period.id));
      setAction({ error: null, isBusy: false });
    } catch (failure: unknown) {
      setAction({ error: messageOf(failure), isBusy: false });
    }
  };

  return (
    <div className="flex flex-col gap-y-6">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Subject" mono>
          {period.subject}
        </Field>
        <Field label="Opened">{formatInstant(period.created_at)}</Field>
        <Field label="Window starts">{formatInstant(period.starts_at)}</Field>
        <Field label="Window ends, exclusive">{formatInstant(period.ends_at)}</Field>
      </div>

      <div className="flex flex-col gap-y-2">
        <Text className="text-ui-fg-subtle" size="small">
          {closability.state === "unknown" && status.error
            ? `Whether this period can be closed is not known: reading the plugin's status failed. ${status.error}`
            : closability.reason}
        </Text>
        {action.error ? <Failure message={action.error} /> : null}
        <div className="flex items-center gap-x-2">
          <Button
            disabled={action.isBusy || closability.state !== "closable"}
            onClick={() => {
              void close();
            }}
            size="small"
          >
            Close period
          </Button>
          <Button
            disabled={action.isBusy || !result}
            onClick={() => {
              void verify();
            }}
            size="small"
            variant="secondary"
          >
            Verify
          </Button>
        </div>
      </div>

      {result ? (
        <Result result={result} />
      ) : (
        <>
          <Empty title="No frozen result">
            This period is open, which means it has not been billed. That is a different thing from
            a result whose total is zero: an open period says do not bill this yet, while a closed
            one worth nothing says it provably came to nothing.
          </Empty>
          <Accrued period={period} rates={status.data?.rates} />
        </>
      )}

      {verification && result ? (
        <Verification result={result} verification={verification} />
      ) : null}
    </div>
  );
};

const Result = ({ result }: { result: PeriodResult }) => (
  <div className="flex flex-col gap-y-3">
    <Text size="small" weight="plus">
      Frozen result
    </Text>
    <Table>
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>Meter</Table.HeaderCell>
          <Table.HeaderCell>Quantity</Table.HeaderCell>
          <Table.HeaderCell>Charged for</Table.HeaderCell>
          <Table.HeaderCell>Events</Table.HeaderCell>
          <Table.HeaderCell>Amount</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {result.lines.map((line) => (
          <Table.Row key={line.meter}>
            <Table.Cell>
              <Text as="span" family="mono" size="small">
                {line.meter}
              </Text>
            </Table.Cell>
            <Table.Cell>{formatQuantity(line.quantity)}</Table.Cell>
            <Table.Cell>{formatQuantity(line.chargeableQuantity)}</Table.Cell>
            <Table.Cell>{formatQuantity(line.eventCount)}</Table.Cell>
            <Table.Cell>{formatAmount(line.amount, result.currency)}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
    <div className="grid grid-cols-2 gap-4">
      <Field label="Total">{formatAmount(result.total, result.currency)}</Field>
      <Field label="Events behind it">{formatQuantity(result.eventCount)}</Field>
      <Field label="Closed">{formatInstant(result.closedAt)}</Field>
      <Field label="Rated from sink">{result.sink}</Field>
      <Field label="Digest" mono>
        {result.digest}
      </Field>
    </div>
  </div>
);

const Verification = ({
  result,
  verification,
}: {
  result: PeriodResult;
  verification: PeriodVerification;
}) => (
  <div className="flex flex-col gap-y-3">
    <Text size="small" weight="plus">
      Re-derived from the log
    </Text>
    <div className="-mx-6 border-t">
      <VerdictLine verdict={readVerification(verification, result)} />
    </div>
    {verification.matches ? null : (
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>Meter</Table.HeaderCell>
            <Table.HeaderCell>Billed</Table.HeaderCell>
            <Table.HeaderCell>Now</Table.HeaderCell>
            <Table.HeaderCell>Quantity delta</Table.HeaderCell>
            <Table.HeaderCell>Amount delta</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {verification.lines.map((line) => (
            <Table.Row key={line.meter}>
              <Table.Cell>
                <Text as="span" family="mono" size="small">
                  {line.meter}
                </Text>
              </Table.Cell>
              <Table.Cell>{formatQuantity(line.quantity)}</Table.Cell>
              <Table.Cell>{formatQuantity(line.currentQuantity)}</Table.Cell>
              <Table.Cell>{formatDelta(line.quantityDelta)}</Table.Cell>
              <Table.Cell>{formatAmountDelta(line.amountDelta, result.currency)}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    )}
  </div>
);

/**
 * What an open period has accrued so far.
 *
 * The one number a screen built around a date picker cannot produce. A period's
 * boundaries are exact to the millisecond and are what it will be billed on, so
 * `periodWindow` hands them to the aggregate unrounded rather than approximating
 * them to the nearest day and reporting a total the eventual invoice will not
 * agree with.
 *
 * It is a running total and it is labelled as one. Nothing is frozen until the
 * period is closed, and a number read here five minutes before a close is not a
 * promise about what the close will find.
 */
const Accrued = ({
  period,
  rates,
}: {
  period: PeriodRow;
  rates: UsageStatusResponse["rates"] | undefined;
}) => {
  const meters = rates?.meters ?? [];
  if (meters.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-y-3">
      <Text size="small" weight="plus">
        Accrued so far, over this period's own boundaries
      </Text>
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>Meter</Table.HeaderCell>
            <Table.HeaderCell>Quantity</Table.HeaderCell>
            <Table.HeaderCell>Events</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {meters.map((rate) => (
            <AccruedRow
              key={rate.meter}
              meter={rate.meter}
              subject={period.subject}
              window={periodWindow(period)}
            />
          ))}
        </Table.Body>
      </Table>
    </div>
  );
};

const AccruedRow = ({
  meter,
  subject,
  window,
}: {
  meter: string;
  subject: string;
  window: UsageWindow;
}) => {
  const { data, error } = useRequest(
    () => getAggregate({ ...window, meter, subject }),
    [meter, subject, window.from, window.to],
  );

  return (
    <Table.Row>
      <Table.Cell>
        <Text as="span" family="mono" size="small">
          {meter}
        </Text>
      </Table.Cell>
      <Table.Cell>
        {data ? (
          formatQuantity(data.total)
        ) : (
          <Tooltip content={error ?? "Reading the log"}>
            <Text as="span" className="text-ui-fg-muted" size="small">
              {error ? "unavailable" : "..."}
            </Text>
          </Tooltip>
        )}
      </Table.Cell>
      <Table.Cell>{data ? formatQuantity(data.eventCount) : "-"}</Table.Cell>
    </Table.Row>
  );
};
