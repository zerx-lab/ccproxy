/**
 * Unit tests for openai-converter.ts
 * Focus on tool-call/tool-result matching
 */

import { convertResponsesInputToAISDK } from "./openai-converter";
import type { ResponseInputItem } from "../types";

// Test case: function_call and function_call_output separated by a message
// This reproduces the bug where tool-calls and tool-results become mismatched
function testToolCallOutputSeparatedByMessage() {
  console.log(
    "Test: function_call and function_call_output separated by message",
  );

  const input: ResponseInputItem[] = [
    { type: "message", role: "developer", content: "System prompt" },
    { type: "message", role: "user", content: "User message" },
    // First batch of function calls with their outputs together
    {
      type: "function_call",
      call_id: "call_1",
      name: "shell",
      arguments: '{"command":"ls"}',
    },
    {
      type: "function_call",
      call_id: "call_2",
      name: "shell",
      arguments: '{"command":"pwd"}',
    },
    { type: "function_call_output", call_id: "call_1", output: "file1.txt" },
    { type: "function_call_output", call_id: "call_2", output: "/home/user" },
    // Second batch - function calls BEFORE the message, outputs AFTER
    // This is the problematic pattern
    {
      type: "function_call",
      call_id: "call_3",
      name: "shell",
      arguments: '{"command":"cat file1.txt"}',
    },
    {
      type: "function_call",
      call_id: "call_4",
      name: "shell",
      arguments: '{"command":"echo hello"}',
    },
    { type: "message", role: "assistant", content: "Processing..." }, // Message separates calls from outputs!
    { type: "function_call_output", call_id: "call_3", output: "content" },
    { type: "function_call_output", call_id: "call_4", output: "hello" },
  ];

  const result = convertResponsesInputToAISDK(input);

  // Validate the result
  let hasError = false;

  // Check that every assistant message with tool-calls is followed by a tool message with all corresponding tool-results
  for (let i = 0; i < result.messages.length; i++) {
    const msg = result.messages[i];
    if (
      msg.role === "assistant" &&
      Array.isArray(msg.content) &&
      msg.content.some((c: any) => c.type === "tool-call")
    ) {
      const toolCallIds = msg.content
        .filter((c: any) => c.type === "tool-call")
        .map((c: any) => c.toolCallId);

      const nextMsg = result.messages[i + 1];
      if (!nextMsg || nextMsg.role !== "tool") {
        console.error(
          `  ERROR: Assistant message at index ${i} with tool-calls ${toolCallIds.join(", ")} is not followed by a tool message`,
        );
        hasError = true;
        continue;
      }

      const toolResultIds = new Set(
        nextMsg.content
          .filter((c: any) => c.type === "tool-result")
          .map((c: any) => c.toolCallId),
      );

      const missingIds = toolCallIds.filter(
        (id: string) => !toolResultIds.has(id),
      );
      if (missingIds.length > 0) {
        console.error(
          `  ERROR: Tool-calls ${missingIds.join(", ")} at index ${i} have no corresponding tool-results`,
        );
        hasError = true;
      }
    }
  }

  if (hasError) {
    console.log("  FAILED");
    console.log("  Messages structure:");
    for (let i = 0; i < result.messages.length; i++) {
      const msg = result.messages[i];
      let info = `    [${i}] role=${msg.role}`;
      if (Array.isArray(msg.content)) {
        info += `, content=[${msg.content.map((c: any) => c.type + (c.toolCallId ? ":" + c.toolCallId : "")).join(", ")}]`;
      } else if (typeof msg.content === "string") {
        info += `, content="${msg.content.substring(0, 30)}..."`;
      }
      console.log(info);
    }
    return false;
  }

  console.log("  PASSED");
  return true;
}

// Test case: Normal flow where function_call and function_call_output are together
function testNormalToolCallFlow() {
  console.log("Test: Normal tool-call flow");

  const input: ResponseInputItem[] = [
    { type: "message", role: "user", content: "List files" },
    {
      type: "function_call",
      call_id: "call_1",
      name: "shell",
      arguments: '{"command":"ls"}',
    },
    { type: "function_call_output", call_id: "call_1", output: "file1.txt" },
    {
      type: "message",
      role: "assistant",
      content: "Here are the files: file1.txt",
    },
  ];

  const result = convertResponsesInputToAISDK(input);

  // Check structure
  let hasError = false;
  for (let i = 0; i < result.messages.length; i++) {
    const msg = result.messages[i];
    if (
      msg.role === "assistant" &&
      Array.isArray(msg.content) &&
      msg.content.some((c: any) => c.type === "tool-call")
    ) {
      const nextMsg = result.messages[i + 1];
      if (!nextMsg || nextMsg.role !== "tool") {
        console.error(
          `  ERROR: Assistant message at index ${i} is not followed by a tool message`,
        );
        hasError = true;
      }
    }
  }

  if (hasError) {
    console.log("  FAILED");
    return false;
  }

  console.log("  PASSED");
  return true;
}

// Test case: Multiple parallel tool calls
function testParallelToolCalls() {
  console.log("Test: Parallel tool calls");

  const input: ResponseInputItem[] = [
    { type: "message", role: "user", content: "Run commands" },
    {
      type: "function_call",
      call_id: "call_1",
      name: "shell",
      arguments: '{"command":"ls"}',
    },

    {
      type: "function_call",
      call_id: "call_2",
      name: "shell",
      arguments: '{"command":"pwd"}',
    },
    {
      type: "function_call",
      call_id: "call_3",
      name: "shell",
      arguments: '{"command":"whoami"}',
    },
    { type: "function_call_output", call_id: "call_1", output: "files" },
    { type: "function_call_output", call_id: "call_2", output: "/home" },
    { type: "function_call_output", call_id: "call_3", output: "user" },
  ];

  const result = convertResponsesInputToAISDK(input);

  // Debug output
  console.log("  DEBUG: Messages structure:");
  for (let i = 0; i < result.messages.length; i++) {
    const msg = result.messages[i];
    let info = `    [${i}] role=${msg.role}`;
    if (Array.isArray(msg.content)) {
      info += `, content=[${msg.content.map((c: any) => c.type + (c.toolCallId ? ":" + c.toolCallId : "")).join(", ")}]`;
    } else if (typeof msg.content === "string") {
      info += `, content="${msg.content.substring(0, 30)}..."`;
    }
    console.log(info);
  }

  // Find the assistant message with tool-calls
  const assistantIdx = result.messages.findIndex(
    (m: any) =>
      m.role === "assistant" &&
      Array.isArray(m.content) &&
      m.content.some((c: any) => c.type === "tool-call"),
  );

  if (assistantIdx === -1) {
    console.error("  ERROR: No assistant message with tool-calls found");
    console.log("  FAILED");
    return false;
  }

  const assistantMsg = result.messages[assistantIdx];
  const toolCalls = assistantMsg.content.filter(
    (c: any) => c.type === "tool-call",
  );

  if (toolCalls.length !== 3) {
    console.error(`  ERROR: Expected 3 tool-calls, got ${toolCalls.length}`);
    console.log("  FAILED");
    return false;
  }

  const toolMsg = result.messages[assistantIdx + 1];
  if (!toolMsg || toolMsg.role !== "tool") {
    console.error("  ERROR: No tool message after assistant");
    console.log("  FAILED");
    return false;
  }

  const toolResults = toolMsg.content.filter(
    (c: any) => c.type === "tool-result",
  );
  if (toolResults.length !== 3) {
    console.error(
      `  ERROR: Expected 3 tool-results, got ${toolResults.length}`,
    );
    console.log("  FAILED");
    return false;
  }

  console.log("  PASSED");
  return true;
}

// Test case: Reproduces the actual error from logs
// Where function_calls appear, then an assistant message, then function_call_outputs
function testActualErrorScenario() {
  console.log("Test: Actual error scenario from logs");

  // This reproduces the exact pattern from the error:
  // [7] function_call call_1
  // [8] function_call call_2
  // [9] function_call_output call_1
  // [10] function_call_output call_2
  // [11] function_call call_3  <- These two have their outputs
  // [12] function_call call_4  <- after the assistant message
  // [13] message assistant
  // [14] function_call_output call_3
  // [15] function_call_output call_4
  const input: ResponseInputItem[] = [
    { type: "message", role: "developer", content: "System prompt" },
    { type: "message", role: "user", content: "Do something" },
    // First: function_call with update_plan
    {
      type: "function_call",
      call_id: "toolu_01FzU6diyBimmkKYuTxnpuP4",
      name: "update_plan",
      arguments: "{}",
    },
    { type: "message", role: "assistant", content: "Planning..." },
    {
      type: "function_call_output",
      call_id: "toolu_01FzU6diyBimmkKYuTxnpuP4",
      output: "Plan updated",
    },
    // Second batch: two function_calls with outputs together
    {
      type: "function_call",
      call_id: "toolu_011byDHjdsqNbUoGD3iincAw",
      name: "shell",
      arguments: '{"command":"ls"}',
    },
    {
      type: "function_call",
      call_id: "toolu_01Enm5mSCV46vJMvd8trPaKt",
      name: "shell",
      arguments: '{"command":"pwd"}',
    },
    {
      type: "function_call_output",
      call_id: "toolu_011byDHjdsqNbUoGD3iincAw",
      output: "files",
    },
    {
      type: "function_call_output",
      call_id: "toolu_01Enm5mSCV46vJMvd8trPaKt",
      output: "/home",
    },
    // Third batch: function_calls BEFORE assistant message, outputs AFTER
    // THIS IS THE PROBLEMATIC PATTERN
    {
      type: "function_call",
      call_id: "toolu_01Xo6EF65fG4jDy88p7w9PP2",
      name: "shell",
      arguments: '{"command":"cat file"}',
    },
    {
      type: "function_call",
      call_id: "toolu_01KoknhzfnjzbUp9h4bEKTAi",
      name: "shell",
      arguments: '{"command":"echo hello"}',
    },
    { type: "message", role: "assistant", content: "Processing results..." },
    {
      type: "function_call_output",
      call_id: "toolu_01Xo6EF65fG4jDy88p7w9PP2",
      output: "file content",
    },
    {
      type: "function_call_output",
      call_id: "toolu_01KoknhzfnjzbUp9h4bEKTAi",
      output: "hello",
    },
    // Final batch
    {
      type: "function_call",
      call_id: "toolu_013SnxqJmGHfCvs76rT9TVqu",
      name: "shell",
      arguments: '{"command":"date"}',
    },
    {
      type: "function_call",
      call_id: "toolu_01NyCKUcmCzafCp3NSdNwj4a",
      name: "shell",
      arguments: '{"command":"whoami"}',
    },
    {
      type: "function_call_output",
      call_id: "toolu_013SnxqJmGHfCvs76rT9TVqu",
      output: "2026-01-27",
    },
    {
      type: "function_call_output",
      call_id: "toolu_01NyCKUcmCzafCp3NSdNwj4a",
      output: "user",
    },
  ];

  const result = convertResponsesInputToAISDK(input);

  // Validate: every assistant message with tool-calls must be followed by tool message with ALL corresponding results
  let hasError = false;

  console.log("  DEBUG: Messages structure:");
  for (let i = 0; i < result.messages.length; i++) {
    const msg = result.messages[i];
    let info = `    [${i}] role=${msg.role}`;
    if (Array.isArray(msg.content)) {
      info += `, content=[${msg.content.map((c: any) => c.type + (c.toolCallId ? ":" + c.toolCallId.slice(-8) : "")).join(", ")}]`;
    } else if (typeof msg.content === "string") {
      info += `, content="${msg.content.substring(0, 20)}..."`;
    }
    console.log(info);
  }

  for (let i = 0; i < result.messages.length; i++) {
    const msg = result.messages[i];
    if (
      msg.role === "assistant" &&
      Array.isArray(msg.content) &&
      msg.content.some((c: any) => c.type === "tool-call")
    ) {
      const toolCallIds = msg.content
        .filter((c: any) => c.type === "tool-call")
        .map((c: any) => c.toolCallId);

      const nextMsg = result.messages[i + 1];
      if (!nextMsg || nextMsg.role !== "tool") {
        console.error(
          `  ERROR: Assistant message at index ${i} with tool-calls is not followed by a tool message`,
        );
        hasError = true;
        continue;
      }

      const toolResultIds = new Set(
        nextMsg.content
          .filter((c: any) => c.type === "tool-result")
          .map((c: any) => c.toolCallId),
      );

      const missingIds = toolCallIds.filter(
        (id: string) => !toolResultIds.has(id),
      );
      if (missingIds.length > 0) {
        console.error(
          `  ERROR: Tool-calls ${missingIds.map((id: string) => id.slice(-8)).join(", ")} have no corresponding tool-results`,
        );
        hasError = true;
      }
    }
  }

  if (hasError) {
    console.log("  FAILED");
    return false;
  }

  console.log("  PASSED");
  return true;
}

// Run all tests
function runTests() {
  console.log("=== OpenAI Converter Unit Tests ===\n");

  const results = [
    testNormalToolCallFlow(),
    testParallelToolCalls(),
    testToolCallOutputSeparatedByMessage(),
    testActualErrorScenario(),
  ];

  console.log("\n=== Summary ===");
  const passed = results.filter((r) => r).length;
  const failed = results.length - passed;
  console.log(`Passed: ${passed}/${results.length}`);
  console.log(`Failed: ${failed}/${results.length}`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
