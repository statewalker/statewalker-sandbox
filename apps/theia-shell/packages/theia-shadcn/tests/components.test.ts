import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Badge,
  Button,
  buttonVariants,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  cn,
  Input,
  Kbd,
  Separator,
} from "../src/browser";

const html = (element: React.ReactElement) => renderToStaticMarkup(element);

describe("cn", () => {
  it("joins conditional classes and lets the later Tailwind utility win", () => {
    expect(cn("px-2 py-1", false && "hidden", "px-4")).toBe("py-1 px-4");
    expect(cn("bg-primary", { "bg-accent": true })).toBe("bg-accent");
  });
});

describe("Button", () => {
  it("renders a <button> tagged with its slot, variant and size", () => {
    const out = html(React.createElement(Button, { variant: "ghost", size: "sm" }, "Go"));
    expect(out).toMatch(/^<button /);
    expect(out).toContain('data-slot="button"');
    expect(out).toContain('data-variant="ghost"');
    expect(out).toContain('data-size="sm"');
    expect(out).toContain("hover:bg-accent");
    expect(out).toContain("h-8");
  });

  it("defaults to the primary variant", () => {
    expect(buttonVariants()).toContain("bg-primary");
    expect(buttonVariants()).toContain("h-9");
  });

  it("merges the caller's classes over the variant's", () => {
    const out = html(React.createElement(Button, { className: "h-auto justify-start" }, "x"));
    expect(out).not.toMatch(/\bh-9\b/);
    expect(out).toContain("h-auto");
  });

  it("asChild renders the child element with the button's classes", () => {
    const link = React.createElement("a", { href: "#x" }, "Link");
    const out = html(React.createElement(Button, { asChild: true, variant: "link" }, link));
    expect(out).toMatch(/^<a /);
    expect(out).toContain('href="#x"');
    expect(out).toContain("underline-offset-4");
  });
});

describe("the other components", () => {
  it("Badge, Input, Kbd, Card and Separator carry their data-slot", () => {
    const out = html(
      React.createElement(
        Card,
        null,
        React.createElement(CardHeader, null, React.createElement(CardTitle, null, "T")),
        React.createElement(
          CardContent,
          null,
          React.createElement(Badge, { variant: "secondary" }, "b"),
          React.createElement(Input, { placeholder: "p" }),
          React.createElement(Kbd, null, "⌘K"),
          React.createElement(Separator, null),
        ),
      ),
    );
    for (const slot of [
      "card",
      "card-header",
      "card-title",
      "card-content",
      "badge",
      "input",
      "kbd",
      "separator",
    ]) {
      expect(out).toContain(`data-slot="${slot}"`);
    }
    expect(out).toContain('role="none"'); // a decorative separator
  });
});
