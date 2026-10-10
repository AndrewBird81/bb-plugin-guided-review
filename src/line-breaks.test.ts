import { expect, test } from "vitest";
import { withLineBreaks } from "./line-breaks";

test("single line breaks become hard breaks, as GitHub shows them", () => {
  expect(withLineBreaks("first\nsecond")).toBe("first  \nsecond");
});

test("paragraphs, list items, and the last line are left alone", () => {
  expect(withLineBreaks("a\n\nb")).toBe("a\n\nb");
  expect(withLineBreaks("- a\n- b")).toBe("- a  \n- b");
  expect(withLineBreaks("only")).toBe("only");
});

test("fenced code keeps its lines exactly", () => {
  expect(withLineBreaks("see:\n```\nx = 1\ny = 2\n```\ndone")).toBe("see:  \n```\nx = 1\ny = 2\n```\ndone");
});
