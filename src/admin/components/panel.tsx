import { Alert, Container, Heading, Skeleton, StatusBadge, Text } from "@medusajs/ui";
import type { PropsWithChildren, ReactNode } from "react";
import type { Verdict } from "../lib/verdicts";

/**
 * The furniture the three panels share.
 *
 * Deliberately small. The screen answers three questions and every one of them is
 * a heading, a verdict, and either a table or a sentence explaining why there is
 * no table - so there are four pieces here and no component library.
 */

/** One bordered section with a title and, optionally, controls on the right. */
export const Panel = ({
  actions,
  children,
  description,
  title,
}: PropsWithChildren<{ actions?: ReactNode; description: string; title: string }>) => (
  <Container className="divide-y p-0">
    <div className="flex flex-col items-start justify-between gap-y-3 px-6 py-4 md:flex-row md:items-center">
      <div className="flex flex-col gap-y-1">
        <Heading level="h2">{title}</Heading>
        <Text className="text-ui-fg-subtle" size="small">
          {description}
        </Text>
      </div>
      {actions ? <div className="flex items-center gap-x-2">{actions}</div> : null}
    </div>
    {children}
  </Container>
);

/** A verdict, as the badge and the sentence behind it. */
export const VerdictLine = ({ verdict }: { verdict: Verdict }) => (
  <div className="flex flex-col items-start gap-y-1 px-6 py-4">
    <StatusBadge color={verdict.tone}>{verdict.headline}</StatusBadge>
    <Text className="text-ui-fg-subtle" size="small">
      {verdict.detail}
    </Text>
  </div>
);

/** A labelled value. `mono` for the ones an operator will compare or copy. */
export const Field = ({
  children,
  label,
  mono,
}: PropsWithChildren<{ label: string; mono?: boolean }>) => (
  <div className="flex flex-col gap-y-1">
    <Text className="text-ui-fg-muted" size="xsmall" weight="plus">
      {label}
    </Text>
    <Text
      className={mono ? "break-all" : undefined}
      family={mono ? "mono" : "sans"}
      size="small"
    >
      {children}
    </Text>
  </div>
);

/**
 * Nothing to show, and why.
 *
 * The most important component here, because on a fresh installation it is the
 * whole screen. A blank panel and a broken panel look identical, so this one never
 * renders without saying which it is: `title` states the fact, `children` says what
 * would have to be true for there to be something, and neither is an apology.
 */
export const Empty = ({ children, title }: PropsWithChildren<{ title: string }>) => (
  <div className="flex flex-col items-center gap-y-2 px-6 py-10 text-center">
    <Text size="small" weight="plus">
      {title}
    </Text>
    <Text className="max-w-lg text-ui-fg-subtle" size="small">
      {children}
    </Text>
  </div>
);

/** A request that failed, in the API's own words. */
export const Failure = ({ message }: { message: string }) => (
  <div className="px-6 py-4">
    <Alert variant="error">{message}</Alert>
  </div>
);

/** Rows-worth of placeholder while a request is in flight. */
export const Loading = ({ rows = 3 }: { rows?: number }) => (
  <div className="flex flex-col gap-y-2 px-6 py-4">
    {Array.from({ length: rows }, (_, index) => (
      <Skeleton className="h-6 w-full" key={index} />
    ))}
  </div>
);
