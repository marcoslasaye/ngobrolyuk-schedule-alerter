/**
 * ConfigSchema — Zod schema for config.yaml.
 *
 * Validates the structure at startup, applies defaults for optional
 * fields (dateRange=7, pollIntervalMs=1800000), and exports the inferred
 * TypeScript type ConfigSchema used across the codebase.
 */
import { z } from "zod";

/** Valid fallback delivery channel types. */
const fallbackTypeSchema = z.enum(["email", "telegram", "none"]);

/** WhatsApp provider (currently only CallMeBot is supported). */
const whatsappProviderSchema = z.literal("callmebot");

/** HH:mm time format for quiet hours. */
const timeSchema = z.string().regex(/^\d{2}:\d{2}$/, "must be HH:mm");

/** Schema for the config.yaml structure. */
export const configSchema = z.object({
  /** Teacher/customer identifier that proxiess the schedule */
  teacherId: z.string().min(1, "teacherId is required"),
  /** Number of days to look ahead (default 7) */
  dateRange: z.number().int().positive().default(7),
  /** Time between poll cycles in ms (default 30 minutes) */
  pollIntervalMs: z.number().int().positive().default(1800000),
  /** Quiet hours during which alerts are suppressed */
  quietHours: z.object({
    start: timeSchema,
    end: timeSchema,
    tz: z.string().min(1, "quietHours.tz is required"),
  }),
  /** WhatsApp delivery channel config (optional — can be empty when using Telegram) */
  whatsapp: z.object({
    provider: whatsappProviderSchema,
    apiKey: z.string().default(""),
    phone: z.string().default(""),
  }),
  /** Fallback delivery channel config */
  fallback: z.object({
    type: fallbackTypeSchema,
    /** Channel-specific config; keys vary by type */
    config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  }),
  /** Directory where the JSON cache lives */
  cachePath: z.string().min(1, "cachePath is required"),
});

/** Inferred TypeScript type for a validated config. */
export type ConfigSchema = z.infer<typeof configSchema>;

/**
 * Validate and parse a raw (YAML-parsed) config object.
 * Applies defaults and throws ZodError on validation failure.
 */
export function parseConfig(raw: unknown): ConfigSchema {
  return configSchema.parse(raw);
}

/**
 * Validate a raw config object returning a boolean.
 * Returns true if valid, false otherwise (logs nothing).
 */
export function validateConfig(raw: unknown): boolean {
  const result = configSchema.safeParse(raw);
  return result.success;
}
