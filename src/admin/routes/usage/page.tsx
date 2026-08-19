import { defineRouteConfig } from "@medusajs/admin-sdk";
import { ChartBar } from "@medusajs/icons";
import { Button, Container, Heading, Input, Label, Text } from "@medusajs/ui";
import { useMemo, useState } from "react";
import { getStatus } from "../../lib/api";
import { EventsDrawer } from "../../components/events-drawer";
import { IngestionPanel } from "../../components/ingestion-panel";
import { MetersPanel } from "../../components/meters-panel";
import { PeriodDrawer } from "../../components/period-drawer";
import { PeriodsPanel } from "../../components/periods-panel";
import { useRequest } from "../../lib/use-request";
import { DEFAULT_WINDOW_DAYS, defaultWindow, resolveWindow } from "../../lib/window";

/**
 * The usage screen.
 *
 * It answers three questions and deliberately nothing else. Is anything being
 * recorded at all; what did one subject consume in one window; is this period
 * closed, can it be, and does it still verify. Everything on it comes from the
 * authenticated admin API this plugin already ships, and no number here is
 * computed on this side of the wire - a total an operator reads has to be the same
 * total a billing run reads, and the only way to guarantee that is for one place
 * to produce it.
 *
 * There are no charts. A chart would answer a fourth question nobody arrived with,
 * and would need a rollup this package does not have to answer it quickly.
 *
 * The state above the panels is the question, not the answer: one subject, one
 * half-open window. It is applied on submit rather than as it is typed, because
 * every panel re-reads when it changes and a half-typed customer id is not a
 * question worth asking the log.
 */
const UsagePage = () => {
  const [draft, setDraft] = useState(() => ({ ...defaultWindow(new Date()), subject: "" }));
  const [applied, setApplied] = useState(draft);

  // Bumped after a close. A close changes what the periods list says and, through
  // the buffer it flushes on the way, what the ingestion panel says.
  const [refreshToken, setRefreshToken] = useState(0);
  const [meter, setMeter] = useState<string | null>(null);
  const [periodId, setPeriodId] = useState<string | null>(null);

  const status = useRequest(() => getStatus(), [refreshToken]);
  const window = useMemo(
    () => resolveWindow(applied.from, applied.to),
    [applied.from, applied.to],
  );
  const meters = useMemo(
    () => status.data?.rates?.meters.map((rate) => rate.meter) ?? [],
    [status.data],
  );

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="flex flex-col gap-y-4">
        <div className="flex flex-col gap-y-1">
          <Heading level="h1">Usage</Heading>
          <Text className="text-ui-fg-subtle" size="small">
            Metered usage, and the billing periods rated from it. Windows are half-open and UTC:
            everything from the first date up to, but not including, the second.
          </Text>
        </div>
        <form
          className="flex flex-col items-start gap-3 md:flex-row md:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            setApplied(draft);
          }}
        >
          <div className="flex flex-col gap-y-1">
            <Label htmlFor="usage-subject" size="xsmall" weight="plus">
              Subject
            </Label>
            <Input
              id="usage-subject"
              onChange={(event) => {
                setDraft((current) => ({ ...current, subject: event.target.value }));
              }}
              placeholder="Every subject"
              size="small"
              value={draft.subject}
            />
          </div>
          <div className="flex flex-col gap-y-1">
            <Label htmlFor="usage-from" size="xsmall" weight="plus">
              From
            </Label>
            <Input
              id="usage-from"
              onChange={(event) => {
                setDraft((current) => ({ ...current, from: event.target.value }));
              }}
              size="small"
              type="date"
              value={draft.from}
            />
          </div>
          <div className="flex flex-col gap-y-1">
            <Label htmlFor="usage-to" size="xsmall" weight="plus">
              To, exclusive
            </Label>
            <Input
              id="usage-to"
              onChange={(event) => {
                setDraft((current) => ({ ...current, to: event.target.value }));
              }}
              size="small"
              type="date"
              value={draft.to}
            />
          </div>
          <Button size="small" type="submit" variant="secondary">
            Apply
          </Button>
          <Button
            onClick={() => {
              const reset = { ...defaultWindow(new Date()), subject: "" };
              setDraft(reset);
              setApplied(reset);
            }}
            size="small"
            type="button"
            variant="transparent"
          >
            Last {DEFAULT_WINDOW_DAYS} days
          </Button>
        </form>
      </Container>

      <IngestionPanel request={status} />

      <MetersPanel
        meters={meters}
        onInspect={setMeter}
        subject={applied.subject}
        window={window.window}
        windowError={window.error}
      />

      <PeriodsPanel
        onSelect={setPeriodId}
        rates={status.data?.rates}
        refreshToken={refreshToken}
        subject={applied.subject}
      />

      <EventsDrawer
        meter={meter}
        onClose={() => {
          setMeter(null);
        }}
        subject={applied.subject}
        window={window.window}
      />

      <PeriodDrawer
        onClose={() => {
          setPeriodId(null);
        }}
        onClosed={() => {
          setRefreshToken((value) => value + 1);
        }}
        periodId={periodId}
        rates={status.data?.rates}
      />
    </div>
  );
};

// Its own sidebar entry. Usage is not a product attribute and not an order one,
// so it does not belong as a column or a widget on either of those screens.
export const config = defineRouteConfig({
  icon: ChartBar,
  label: "Usage",
});

export default UsagePage;
