import { Button, Drawer, Table, Text } from "@medusajs/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UsageEventRow, UsageWindow } from "../lib/api";
import { listEvents } from "../lib/api";
import { abbreviate, formatInstant, formatQuantity } from "../lib/format";
import { messageOf } from "../lib/use-request";
import { Empty, Failure, Loading } from "./panel";

/** Events per request. The route's own default, restated so the button matches it. */
const PAGE_SIZE = 50;

/**
 * The events behind a number.
 *
 * This is the audit path, and the reason it is a drawer rather than a page is that
 * it is only ever opened from a total someone is already looking at. When a
 * customer disputes what they were billed, what settles it is the individual facts
 * the total was computed from - not another total computed the same way - and the
 * `key` column is what makes each of those facts checkable: it is derived from the
 * event, so the same event always has the same key however many times it was sent.
 *
 * Paging is keyset, oldest first, exactly as the route serves it. Pages accumulate
 * rather than replace, because reading an audit trail means reading along it.
 */
export const EventsDrawer = ({
  meter,
  onClose,
  subject,
  window,
}: {
  /** The meter to show, or null when the drawer is closed. */
  meter: string | null;
  onClose: () => void;
  subject: string;
  window: UsageWindow | null;
}) => {
  const { t } = useTranslation();

  // Four whole sentences rather than one assembled from four fragments. The old
  // version concatenated " for X" and ", from A up to B" onto a bare meter name,
  // which is untranslatable: Polish puts the subject in a different case and does
  // not order the clauses the same way, so there is nothing for a translator to
  // attach the fragments to.
  const description = t(
    subject
      ? window
        ? "usage.events.descriptionSubject"
        : "usage.events.descriptionSubjectNoWindow"
      : window
        ? "usage.events.descriptionAll"
        : "usage.events.descriptionAllNoWindow",
    {
      from: window ? formatInstant(window.from) : "",
      meter,
      subject,
      to: window ? formatInstant(window.to) : "",
    },
  );

  return (
    <Drawer
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={meter !== null && window !== null}
    >
      <Drawer.Content>
        <Drawer.Header>
          <Drawer.Title>{t("usage.events.title")}</Drawer.Title>
          <Drawer.Description>{description}</Drawer.Description>
        </Drawer.Header>
        <Drawer.Body className="overflow-y-auto">
          {meter && window ? <Events meter={meter} subject={subject} window={window} /> : null}
        </Drawer.Body>
      </Drawer.Content>
    </Drawer>
  );
};

const Events = ({
  meter,
  subject,
  window,
}: {
  meter: string;
  subject: string;
  window: UsageWindow;
}) => {
  const { t } = useTranslation();
  const [rows, setRows] = useState<UsageEventRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pagingError, setPagingError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Which question the rows on screen belong to. A page that arrives after the
  // meter, subject or window has changed belongs to a question nobody is asking
  // any more, and appending it would put another meter's events in this table.
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    const asked = generation.current;

    setIsLoading(true);
    setError(null);
    setPagingError(null);
    setRows([]);
    setCursor(null);

    listEvents({ ...window, limit: PAGE_SIZE, meter, subject: subject || null })
      .then((page) => {
        if (asked === generation.current) {
          setRows(page.events);
          setCursor(page.next_cursor);
          setIsLoading(false);
        }
      })
      .catch((failure: unknown) => {
        if (asked === generation.current) {
          setError(messageOf(t, failure));
          setIsLoading(false);
        }
      });
  }, [meter, subject, window.from, window.to]);

  const loadMore = () => {
    const asked = generation.current;
    setIsLoading(true);
    setPagingError(null);

    listEvents({ ...window, cursor, limit: PAGE_SIZE, meter, subject: subject || null })
      .then((page) => {
        if (asked === generation.current) {
          setRows((current) => [...current, ...page.events]);
          setCursor(page.next_cursor);
          setIsLoading(false);
        }
      })
      .catch((failure: unknown) => {
        if (asked === generation.current) {
          // Deliberately not `error`: the pages already read are still the audit
          // trail, and replacing them with an alert would throw away the answer
          // to punish the request that failed to extend it.
          setPagingError(messageOf(t, failure));
          setIsLoading(false);
        }
      });
  };

  if (error) {
    return <Failure message={error} />;
  }
  if (isLoading && rows.length === 0) {
    return <Loading rows={5} />;
  }
  if (rows.length === 0) {
    return (
      <Empty title={t("usage.events.emptyTitle")}>{t("usage.events.emptyBody")}</Empty>
    );
  }

  return (
    <div className="flex flex-col gap-y-4">
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("usage.events.columns.occurred")}</Table.HeaderCell>
            <Table.HeaderCell>{t("usage.common.subject")}</Table.HeaderCell>
            <Table.HeaderCell>{t("usage.common.quantity")}</Table.HeaderCell>
            <Table.HeaderCell>{t("usage.events.columns.source")}</Table.HeaderCell>
            <Table.HeaderCell>{t("usage.events.columns.key")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((event) => (
            <Table.Row key={event.key}>
              <Table.Cell>{formatInstant(event.occurred_at)}</Table.Cell>
              <Table.Cell>
                <Text as="span" family="mono" size="small">
                  {event.subject}
                </Text>
              </Table.Cell>
              <Table.Cell>{formatQuantity(event.quantity)}</Table.Cell>
              <Table.Cell>{event.source ?? "-"}</Table.Cell>
              <Table.Cell title={event.key}>
                <Text as="span" family="mono" size="xsmall">
                  {abbreviate(event.key, 18)}
                </Text>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
      {pagingError ? <Failure message={pagingError} /> : null}
      <div className="flex items-center justify-between">
        <Text className="text-ui-fg-subtle" size="small">
          {t(cursor ? "usage.events.shownMore" : "usage.events.shownAll", {
            count: rows.length,
            shown: formatQuantity(rows.length),
          })}
        </Text>
        {cursor ? (
          <Button disabled={isLoading} onClick={loadMore} size="small" variant="secondary">
            {pagingError ? t("usage.events.tryAgain") : t("usage.events.loadMore")}
          </Button>
        ) : null}
      </div>
    </div>
  );
};
