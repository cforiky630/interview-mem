import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveAiStreamCompletion,
  shouldDeferAiScopeReload,
  type AiStreamSession,
} from "../src/components/ai-island";

describe("AI background stream survival helpers", () => {
  const streamingSession: AiStreamSession = {
    scope: "question",
    scopeKey: "q:q-1",
    label: "Fiber 架构为什么能中断渲染？",
    questionId: "q-1",
    status: "streaming",
  };

  const completedSession: AiStreamSession = {
    ...streamingSession,
    status: "completed",
  };

  it("defers scope reload while a stream is actively in flight", () => {
    assert.equal(
      shouldDeferAiScopeReload({ inFlight: true, streamSession: streamingSession }),
      true,
    );
    assert.equal(
      shouldDeferAiScopeReload({ inFlight: true, streamSession: null }),
      true,
    );
  });

  it("defers scope reload while a completed background stream stays pinned", () => {
    assert.equal(
      shouldDeferAiScopeReload({ inFlight: false, streamSession: completedSession }),
      true,
    );
  });

  it("allows scope reload once idle and unpinned", () => {
    assert.equal(
      shouldDeferAiScopeReload({ inFlight: false, streamSession: null }),
      false,
    );
  });

  it("marks unread and offers toast action when finishing while collapsed and visible", () => {
    assert.deepEqual(
      resolveAiStreamCompletion({
        mode: "collapsed",
        hidden: false,
        targetKey: "q:q-1",
        currentScopeKey: "q:q-1",
      }),
      {
        finishedInBackground: true,
        markUnread: true,
        keepPinnedCompleted: true,
        showToastAction: true,
      },
    );
  });

  it("marks unread without open-toast action when hidden during unrevealed review", () => {
    assert.deepEqual(
      resolveAiStreamCompletion({
        mode: "collapsed",
        hidden: true,
        targetKey: "q:q-1",
        currentScopeKey: "u:u-1",
      }),
      {
        finishedInBackground: true,
        markUnread: true,
        keepPinnedCompleted: true,
        showToastAction: false,
      },
    );
  });

  it("keeps cross-context stream pinned without unread badge when panel is already open", () => {
    assert.deepEqual(
      resolveAiStreamCompletion({
        mode: "docked",
        hidden: false,
        targetKey: "q:q-1",
        currentScopeKey: "q:q-2",
      }),
      {
        finishedInBackground: false,
        markUnread: false,
        keepPinnedCompleted: true,
        showToastAction: false,
      },
    );
  });

  it("clears pin and unread when finishing in foreground on the same scope", () => {
    assert.deepEqual(
      resolveAiStreamCompletion({
        mode: "docked",
        hidden: false,
        targetKey: "q:q-1",
        currentScopeKey: "q:q-1",
      }),
      {
        finishedInBackground: false,
        markUnread: false,
        keepPinnedCompleted: false,
        showToastAction: false,
      },
    );
  });
});
