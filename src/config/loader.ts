/**
 * ConfigPort — YAML loader.
 *
 * Reads config.yaml (from project root), parses YAML, expands ${VAR}
 * environment-variable placeholders, and validates the result with the
 * Zod schema. Throws a descriptive error on validation failure so the
 * CLI can exit with code 1 and log the offending field.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { configSchema, type ConfigSchema } from "./schema.js";

/** Regex matching ${VAR} environment placeholders. */
const ENV_VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Expand ${VAR} placeholders in a string using process.env.
 * Leaves unknown variables unresolved (as-is).
 */
export function interpolateEnv(value: string): string {
  return value.replace(ENV_VAR_RE, (match, name: string) => {
    const val = process.env[name];
    return val !== undefined ? val : match;
  });
}

/**
 * Recursively interpolate env vars into a nested parsed-YAML structure.
 * Only string leaf values are interpolated.
 */
function interpolateDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return interpolateEnv(value);
  }
  if (Array.isArray(value)) {
    return value.map(interpolateDeep);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolateDeep(v);
    }
    return out;
  }
  return value;
}

/** Parse a YAML string into a plain JavaScript object. */
export function readYamlFile(content: string): Record<string, unknown> {
  return parseYaml(content) as Record<string, unknown>;
}

/**
 * Resolve the config file path: cwd/config.yaml or
 * ~/.schedule-alerter/config.yaml (home fallback).
 */
export function resolveConfigPath(): string {
  const cwdPath = resolve(process.cwd(), "config.yaml");
  if (existsSync(cwdPath)) {
    return cwdPath;
  }
  return resolve(homedir(), ".schedule-alerter", "config.yaml");
}

/**
 * Load, interpolate, and validate config from a YAML string.
 * Throws ZodError / descriptive Error on invalid config.
 */
export function loadConfig(yamlContent: string): ConfigSchema {
  const raw = readYamlFile(yamlContent);
  const interpolated = interpolateDeep(raw);
  return configSchema.parse(interpolated);
}

/**
 * Load config from disk using resolveConfigPath().
 * Throws if the file is missing or fails validation.
 */
export function loadConfigFile(path?: string): ConfigSchema {
  const filePath = path ?? resolveConfigPath();
  if (!existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}. Copy config.yaml.example to config.yaml.`);
  }
  const content = readFileSync(filePath, "utf8");
  return loadConfig(content);
}

/** ConfigPort interface — satisfies the design's port contract. */
export interface ConfigPort {
  load(): ConfigSchema;
}
