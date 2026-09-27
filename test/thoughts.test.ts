import { expect, test } from "vitest";
import { splitThoughts } from "../web/src/thoughts.js";

test("reasoning tags are separated from the answer", () => {
  expect(splitThoughts("<thought>User wants days.</thought>\nYou get **21 days**.")).toEqual([
    { kind: "thought", text: "User wants days." },
    { kind: "answer", text: "You get **21 days**." },
  ]);
  expect(splitThoughts("A <THINK>x</THINK> B <thinking>y</thinking> C").map((p) => p.kind)).toEqual(["answer", "thought", "answer", "thought", "answer"]);
  expect(splitThoughts("Answer. <thought>still thinking")).toEqual([{ kind: "answer", text: "Answer." }, { kind: "thought", text: "still thinking" }]);
  expect(splitThoughts("plain text")).toEqual([{ kind: "answer", text: "plain text" }]);
  expect(splitThoughts("<thought></thought>Hi")).toEqual([{ kind: "answer", text: "Hi" }]);
});
