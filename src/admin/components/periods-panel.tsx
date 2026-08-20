import { Button, Select, StatusBadge, Table, Text } from "@medusajs/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PeriodRow, UsageStatusResponse } from "../lib/api";
import { listPeriods } from "../lib/api";
import { formatInstant } from "../lib/format";
import type { Request } from "../lib/use-request";
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
  refreshToken,
  status: statusRequest,
  subject,
}: {
  onSelect: (id: string) => void;
  /** Bumped by the page after a close, so the list reflects it. */
  refreshToken: number;
  /**
   * The whole status request rather than its rate card, because "not read yet"
   * and "could not be read" produce the same absent rate card and must not
   * produce the same sentence.
   */
  status: Request<UsageStatusResponse>;
  subject: string;
}) => {
  const { t } = useTranslation();
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
              <Select.Value placeholder={t("usage.periods.status.any")} />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="any">{t("usage.periods.status.any")}</Select.Item>
              <Select.Item value="open">{t("usage.periods.status.open")}</Select.Item>
              <Select.Item value="closed">{t("usage.periods.status.closed")}</Select.Item>
            </Select.Content>
          </Select>
          <Button
            disabled={request.isLoading}
            onClick={request.reload}
            size="small"
            variant="secondary"
          >
            {t("usage.common.refresh")}
          </Button>
        </>
      }
      description={
        // The subject filter applies here; the dates above do not. A period is
        // billed on its own boundaries, and hiding one because it falls outside a
        // window someone picked for a different question would be the worst kind of
        // helpful.
        subject
          ? t("usage.periods.descriptionSubject", { subject })
          : t("usage.periods.descriptionAll")
      }
      title={t("usage.periods.title")}
    >
      {request.error ? <Failure message={request.error} /> : null}
      {request.isLoading && !request.data ? <Loading /> : null}
      {request.data && periods.length === 0 ? <PeriodsEmpty filtered={filtered} /> : null}
      {periods.length > 0 ? (
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t("usage.common.subject")}</Table.HeaderCell>
              <Table.HeaderCell>{t("usage.periods.columns.window")}</Table.HeaderCell>
              <Table.HeaderCell>{t("usage.periods.columns.status")}</Table.HeaderCell>
              <Table.HeaderCell>{t("usage.periods.columns.closable")}</Table.HeaderCell>
              <Table.HeaderCell />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {periods.map((period) => (
              <PeriodRowView
                key={period.id}
                onSelect={onSelect}
                period={period}
                status={statusRequest}
              />
            ))}
          </Table.Body>
        </Table>
      ) : null}
      {periods.length === PAGE_SIZE ? (
        <div className="px-6 py-3">
          <Text className="text-ui-fg-subtle" size="small">
            {t("usage.periods.truncated", { count: PAGE_SIZE })}
          </Text>
        </div>
      ) : null}
    </Panel>
  );
};

const PeriodRowView = ({
  onSelect,
  period,
  status,
}: {
  onSelect: (id: string) => void;
  period: PeriodRow;
  status: Request<UsageStatusResponse>;
}) => {
  const { t } = useTranslation();
  const closability = readClosability(t, period, status.data?.rates, new Date());

  return (
    <Table.Row>
      <Table.Cell>
        <Text as="span" family="mono" size="small">
          {period.subject}
        </Text>
      </Table.Cell>
      <Table.Cell>
        {t("usage.periods.windowRange", {
          from: formatInstant(period.starts_at),
          to: formatInstant(period.ends_at),
        })}
      </Table.Cell>
      <Table.Cell>
        <StatusBadge color={period.closed_at ? "green" : "grey"}>
          {period.closed_at ? t("usage.periods.badge.closed") : t("usage.periods.badge.open")}
        </StatusBadge>
      </Table.Cell>
      <Table.Cell>
        <Text className="text-ui-fg-subtle" size="small">
          {closability.state === "unknown" && status.error
            ? t("usage.periods.statusUnavailable")
            : t(SHORT_REASON[closability.state])}
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
          {t("usage.periods.open")}
        </Button>
      </Table.Cell>
    </Table.Row>
  );
};

/**
 * The column is a glance; the drawer carries the reason in full.
 *
 * Translation keys rather than words, so the map stays a plain constant outside
 * the component and the lookup happens where `t` is.
 */
const SHORT_REASON: Record<ReturnType<typeof readClosability>["state"], string> = {
  closable: "usage.periods.shortReason.closable",
  closed: "usage.periods.shortReason.closed",
  "no-rate-card": "usage.periods.shortReason.noRateCard",
  "too-early": "usage.periods.shortReason.tooEarly",
  unknown: "usage.periods.shortReason.unknown",
};

/**
 * Exported so the copy can be asserted. On a fresh installation this is the whole
 * panel, and the difference between "nothing has happened yet" and "something is
 * broken" is the only thing it has to get right.
 */
export const PeriodsEmpty = ({ filtered }: { filtered: boolean }) => {
  const { t } = useTranslation();

  return filtered ? (
    <Empty title={t("usage.periods.emptyFilteredTitle")}>
      {t("usage.periods.emptyFilteredBody")}
    </Empty>
  ) : (
    <Empty title={t("usage.periods.emptyTitle")}>{t("usage.periods.emptyBody")}</Empty>
  );
};
