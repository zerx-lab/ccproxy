#!/usr/bin/env bun
import { Command } from "commander";
import { authorize, exchange, type ExchangeSuccess } from "./auth";
import { saveAuth, loadAuth, clearAuth, getConfigDir, getConfigFile, loadConfig, saveConfig, getDefaultConfig, generateApiKey, saveApiKey, loadApiKey, clearApiKey, type AuthData, type ApiKeyData } from "./storage";
import { startServer } from "./server";
import * as readline from "readline";

const program = new Command();

program
  .name("ccproxy")
  .description("Claude Code subscription proxy server")
  .version("1.0.0");

// Login 命令
program
  .command("login")
  .description("Login with Claude Pro/Max subscription")
  .option("-m, --mode <mode>", "Login mode: max or console", "max")
  .action(async (options) => {
    const mode = options.mode as "max" | "console";

    console.log("Starting OAuth login flow...\n");

    try {
      const { url, verifier } = await authorize(mode);

      console.log("Please open the following URL in your browser:\n");
      console.log(`  ${url}\n`);
      console.log("After authorization, you will receive a code.");
      console.log("Paste the authorization code below:\n");

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const code = await new Promise<string>((resolve) => {
        rl.question("Authorization code: ", (answer) => {
          rl.close();
          resolve(answer.trim());
        });
      });

      if (!code) {
        console.error("\nError: No authorization code provided.");
        process.exit(1);
      }

      console.log("\nExchanging code for tokens...");

      const result = await exchange(code, verifier);

      if (result.type === "failed") {
        console.error("\nError: Failed to exchange authorization code.");
        console.error("Please make sure you copied the full code correctly.");
        process.exit(1);
      }

      const auth: AuthData = {
        type: "oauth",
        refresh: result.refresh,
        access: result.access,
        expires: result.expires,
      };

      await saveAuth(auth);

      console.log("\nLogin successful!");
      console.log(`Credentials saved to: ${getConfigDir()}`);
      console.log("\nYou can now start the proxy server with:");
      console.log("  ccproxy start");
    } catch (error) {
      console.error("\nError during login:", error);
      process.exit(1);
    }
  });

// Start 命令
program
  .command("start")
  .description("Start the proxy server")
  .option("-p, --port <port>", "Port to listen on", "3456")
  .option("-h, --host <host>", "Host to bind to", "127.0.0.1")
  .action(async (options) => {
    const port = parseInt(options.port, 10);
    const host = options.host;

    if (isNaN(port) || port < 1 || port > 65535) {
      console.error("Error: Invalid port number");
      process.exit(1);
    }

    // 检查是否已登录
    const auth = await loadAuth();
    if (!auth) {
      console.error("Error: Not logged in.");
      console.error("Please run 'ccproxy login' first.");
      process.exit(1);
    }

    console.log("Checking authentication status...");

    // 检查 token 是否过期
    if (auth.expires < Date.now()) {
      console.log("Access token expired, will refresh on first request.");
    } else {
      const expiresIn = Math.round((auth.expires - Date.now()) / 1000 / 60);
      console.log(`Access token valid for ${expiresIn} minutes.`);
    }

    await startServer({ port, host });
  });

// Status 命令
program
  .command("status")
  .description("Check authentication status")
  .action(async () => {
    const auth = await loadAuth();

    if (!auth) {
      console.log("Status: Not logged in");
      console.log("\nRun 'ccproxy login' to authenticate.");
      return;
    }

    console.log("Status: Logged in");
    console.log(`Config directory: ${getConfigDir()}`);

    if (auth.expires < Date.now()) {
      console.log("Access token: Expired (will refresh on next request)");
    } else {
      const expiresIn = Math.round((auth.expires - Date.now()) / 1000 / 60);
      console.log(`Access token: Valid for ${expiresIn} minutes`);
    }
  });

// Logout 命令
program
  .command("logout")
  .description("Clear saved credentials")
  .action(async () => {
    await clearAuth();
    console.log("Credentials cleared.");
  });

// Config 命令
const configCmd = program
  .command("config")
  .description("Manage configuration");

configCmd
  .command("show")
  .description("Show current configuration")
  .action(async () => {
    const config = await loadConfig();
    console.log("Configuration file:", getConfigFile());
    console.log("\nModel mappings:");
    for (const [from, to] of Object.entries(config.modelMapping)) {
      console.log(`  ${from} -> ${to}`);
    }
    console.log("\nServer settings:");
    console.log(`  Host: ${config.server.host}`);
    console.log(`  Port: ${config.server.port}`);
  });

configCmd
  .command("reset")
  .description("Reset configuration to defaults")
  .action(async () => {
    await saveConfig(getDefaultConfig());
    console.log("Configuration reset to defaults.");
  });

configCmd
  .command("set-model <from> <to>")
  .description("Add or update a model mapping")
  .action(async (from: string, to: string) => {
    const config = await loadConfig();
    config.modelMapping[from] = to;
    await saveConfig(config);
    console.log(`Model mapping added: ${from} -> ${to}`);
  });

configCmd
  .command("remove-model <name>")
  .description("Remove a model mapping")
  .action(async (name: string) => {
    const config = await loadConfig();
    if (config.modelMapping[name]) {
      delete config.modelMapping[name];
      await saveConfig(config);
      console.log(`Model mapping removed: ${name}`);
    } else {
      console.log(`Model mapping not found: ${name}`);
    }
  });

configCmd
  .command("path")
  .description("Show configuration file path")
  .action(() => {
    console.log(getConfigFile());
  });

// API Key 命令组
const apikeyCmd = program
  .command("apikey")
  .description("Manage API keys for proxy authentication");

apikeyCmd
  .command("generate")
  .description("Generate a new API key (replaces existing key if any)")
  .action(async () => {
    const existing = await loadApiKey();
    if (existing) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const confirm = await new Promise<string>((resolve) => {
        rl.question("An API key already exists. Replace it? (y/N): ", (answer) => {
          rl.close();
          resolve(answer.trim().toLowerCase());
        });
      });

      if (confirm !== "y" && confirm !== "yes") {
        console.log("Cancelled.");
        return;
      }
    }

    const key = generateApiKey();
    const apiKeyData: ApiKeyData = {
      key,
      createdAt: Date.now(),
    };

    await saveApiKey(apiKeyData);

    console.log("\nAPI Key generated successfully!\n");
    console.log(`  ${key}\n`);
    console.log("Use this key in the Authorization header:");
    console.log(`  Authorization: Bearer ${key}\n`);
    console.log("Or as x-api-key header:");
    console.log(`  x-api-key: ${key}\n`);
    console.log("Save this key securely - it cannot be recovered once lost.");
  });

apikeyCmd
  .command("show")
  .description("Show current API key")
  .action(async () => {
    const apiKey = await loadApiKey();

    if (!apiKey) {
      console.log("No API key configured.");
      console.log("\nGenerate one with: ccproxy apikey generate");
      return;
    }

    const createdDate = new Date(apiKey.createdAt).toLocaleString();
    console.log("Current API Key:");
    console.log(`  ${apiKey.key}\n`);
    console.log(`Created: ${createdDate}`);
  });

apikeyCmd
  .command("revoke")
  .description("Revoke (delete) the current API key")
  .action(async () => {
    const existing = await loadApiKey();
    if (!existing) {
      console.log("No API key to revoke.");
      return;
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const confirm = await new Promise<string>((resolve) => {
      rl.question("Are you sure you want to revoke the API key? (y/N): ", (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase());
      });
    });

    if (confirm !== "y" && confirm !== "yes") {
      console.log("Cancelled.");
      return;
    }

    await clearApiKey();
    console.log("API key revoked. The proxy will accept all requests without authentication.");
  });

program.parse();
