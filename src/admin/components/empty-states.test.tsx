import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mountI18n } from "../i18n/__tests__/instance";
import type { UsageStatusResponse } from "../lib/api";
import type { Request } from "../lib/use-request";
import UsagePage from "../routes/usage/page";
import { IngestionPanel } from "./ingestion-panel";
import { MetersPanel } from "./meters-panel";
import { PeriodsEmpty } from "./periods-panel";

/**
 * What the screen says when there is nothing on it.
 *
 * This is the state a fresh installation is in, and the one the plugin was in when
 * this screen was asked for: no usage recorded, no periods opened, possibly no rate
 * card. A screen that looked broken in that state would be worse than no screen at
 * all, so what each panel says while it is empty is asserted rather than left to
 * whoever edits the copy next.
 *
 * Rendered to static markup, which runs the components without a browser and
 * without effects. That is a real limit and it is the right one here: the empty
 * branches are exactly the ones that render without a request having resolved.
 *
 * i18next is initialised from the plugin's own `en.json` and `pl.json` before
 * anything renders, so every assertion below is on a string that came out of a
 * translation file rather than out of a component. The Polish block at the end
 * renders the same trees in Polish, which is the assertion that would have caught
 * the defect this file exists for: a hardcoded English string renders identically
 * in both languages and would pass an English-only test forever.
 */

// Stubbed so importing a panel does not construct an admin client. Nothing below
// makes a request - an empty panel is precisely the one that has not had an answer
// yet - and a test that needed a client to prove that would be proving something
// else.
vi.mock("../lib/sdk", () => ({ sdk: { client: { fetch: vi.fn() } } }));

beforeAll(async () => {
  await mountI18n("en");
});

const render = (element: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(element).replaceAll(/<[^>]+>/gu, " ");

const status = (overrides: Partial<UsageStatusResponse> = {}): UsageStatusResponse => ({
  batch_size: 500,
  buffered: 0,
  flush_interval_ms: 5000,
  flush_mode: "buffered",
  last_flush_at: null,
  last_flush_error: null,
  oldest_buffered_ms: 0,
  rates: null,
  sink: "postgres",
  sinks: ["postgres"],
  ...overrides,
});

const settled = <T,>(data: T | null, error: string | null = null): Request<T> => ({
  data,
  error,
  isLoading: false,
  reload: () => undefined,
});

describe("the ingestion panel with nothing recorded", () => {
  it("refuses to call an untouched installation either healthy or broken", () => {
    const html = render(<IngestionPanel request={settled(status())} />);
    expect(html).toContain("Nothing has arrived yet");
    expect(html).toContain("broken producer");
  });

  it("says a rate card is absent rather than missing, and what that costs", () => {
    const html = render(<IngestionPanel request={settled(status())} />);
    expect(html).toContain("Metering only");
    expect(html).toContain("not closed");
  });

  it("shows a failed read in the API's own words", () => {
    const html = render(
      <IngestionPanel request={settled<UsageStatusResponse>(null, "medusa-usage: no sink")} />,
    );
    expect(html).toContain("medusa-usage: no sink");
  });
});

describe("the meters panel with no rate card", () => {
  it("explains why it cannot list the meters instead of showing an empty table", () => {
    const html = render(
      <MetersPanel
        meters={[]}
        onInspect={() => undefined}
        subject=""
        window={{ from: "2026-08-01T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" }}
        windowError={null}
      />,
    );
    expect(html).toContain("No meters to ask about");
    expect(html).toContain("records whatever a producer sends");
  });

  it("reports a bad window as the operator's typo rather than asking the log about it", () => {
    const html = render(
      <MetersPanel
        meters={["api_request"]}
        onInspect={() => undefined}
        subject=""
        window={null}
        windowError="The window ends before it starts."
      />,
    );
    expect(html).toContain("The window ends before it starts.");
    expect(html).not.toContain("api_request");
  });
});

describe("the periods panel with no periods", () => {
  it("says the plugin does not open periods, and who does", () => {
    const html = render(<PeriodsEmpty filtered={false} />);
    expect(html).toContain("No periods have been opened");
    expect(html).toContain("not a fault");
    expect(html).toContain("POST /admin/usage/periods");
  });

  it("distinguishes nothing matching from nothing existing", () => {
    const html = render(<PeriodsEmpty filtered />);
    expect(html).toContain("No periods match these filters");
  });
});

describe("the screen before anything has answered", () => {
  it("renders every panel, and none of them is blank", () => {
    // The first paint on a fresh installation. Every panel is present and each one
    // says what it is waiting for, which is the difference between a screen that is
    // loading and a screen that is broken.
    const html = render(<UsagePage />);
    expect(html).toContain("Ingestion");
    expect(html).toContain("Meters");
    expect(html).toContain("Billing periods");
    expect(html).toContain("half-open and UTC");
  });
});

/**
 * The same screen, in Polish.
 *
 * This is the block that proves the strings are translated rather than merely
 * present. Every assertion here is a string that only exists in `pl.json`, so a
 * component that went back to a hardcoded English literal would fail here while
 * every English assertion above kept passing.
 */
describe("the same empty screen in Polish", () => {
  beforeAll(async () => {
    await mountI18n("pl");
  });

  afterAll(async () => {
    // The i18next instance is a module-level singleton shared with any test file
    // that renders after this one.
    await mountI18n("en");
  });

  it("renders every panel heading in Polish", () => {
    const html = render(<UsagePage />);
    expect(html).toContain("Przyjmowanie zdarzeń");
    expect(html).toContain("Liczniki");
    expect(html).toContain("Okresy rozliczeniowe");
    expect(html).toContain("półotwarte");
    // The English the panels used to hardcode is gone, not merely joined.
    expect(html).not.toContain("Billing periods");
    expect(html).not.toContain("half-open and UTC");
  });

  it("says in Polish that an untouched installation is neither healthy nor broken", () => {
    const html = render(<IngestionPanel request={settled(status())} />);
    expect(html).toContain("Nic jeszcze nie dotarło");
    expect(html).toContain("zepsuty producent");
    // The nested `$t(...)` sentence resolved rather than leaking its own key.
    expect(html).toContain("obsłużyła to żądanie");
    expect(html).not.toContain("usage.verdicts");
  });

  it("keeps the two empty-period states apart in Polish too", () => {
    expect(render(<PeriodsEmpty filtered={false} />)).toContain("Nie otwarto żadnego okresu");
    expect(render(<PeriodsEmpty filtered />)).toContain("Żaden okres nie pasuje do tych filtrów");
  });

  it("explains the missing rate card in Polish rather than showing an empty table", () => {
    const html = render(
      <MetersPanel
        meters={[]}
        onInspect={() => undefined}
        subject=""
        window={{ from: "2026-08-01T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" }}
        windowError={null}
      />,
    );
    expect(html).toContain("Nie ma o jaki licznik zapytać");
    expect(html).toContain("producent zdarzeń");
  });
});
