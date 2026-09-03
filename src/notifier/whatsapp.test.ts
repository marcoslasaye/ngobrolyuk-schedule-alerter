/**
 * Tests for the CallMeBot WhatsApp client.
 *
 * Uses nock to mock the CallMeBot HTTP API. Verifies the GET request shape
 * (phone + apikey + text params), retry of transient failures (429/5xx), and
 * no retry on non-retryable 4xx.
 */
import { afterEach, describe, it, expect } from "vitest";
import nock from "nock";
import {
  sendWhatsApp,
  WHATSAPP_BASE_URL,
  WHATSAPP_PATH,
  WHATSAPP_DEFAULT_RETRY_DELAYS,
} from "./whatsapp.js";

const CONFIG = { phone: "628123456789", apiKey: "test-key" };

afterEach(() => {
  nock.cleanAll();
});

describe("sendWhatsApp", () => {
  it("sends a GET with phone, apikey, and text parameters", async () => {
    nock(WHATSAPP_BASE_URL)
      .get(WHATSAPP_PATH)
      .query((q) => {
        expect(q.phone).toBe("628123456789");
        expect(q.apikey).toBe("test-key");
        expect(q.text).toContain("Schedule Change Alert");
        return true;
      })
      .reply(200, "Message sent");

    const result = await sendWhatsApp("Schedule Change Alert", CONFIG, {
      retryDelays: [],
    });
    expect(result.success).toBe(true);
    expect(result.channel).toBe("whatsapp");
    expect(result.error).toBeUndefined();
  });

  it("recovers from a transient 503 on retry", async () => {
    nock(WHATSAPP_BASE_URL)
      .get(WHATSAPP_PATH)
      .query(true)
      .reply(503, "Server Error")
      .get(WHATSAPP_PATH)
      .query(true)
      .reply(200, "Message sent");

    const result = await sendWhatsApp("Hello", CONFIG, {
      retryDelays: [5, 5],
    });
    expect(result.success).toBe(true);
    expect(result.channel).toBe("whatsapp");
  });

  it("returns failure after all retries are exhausted on persistent 5xx", async () => {
    // 3 attempts total (initial + 2 retries).
    nock(WHATSAPP_BASE_URL)
      .get(WHATSAPP_PATH)
      .query(true)
      .reply(503, "bad")
      .get(WHATSAPP_PATH)
      .query(true)
      .reply(503, "bad")
      .get(WHATSAPP_PATH)
      .query(true)
      .reply(503, "bad");

    const result = await sendWhatsApp("Hello", CONFIG, {
      retryDelays: [5, 5],
    });
    expect(result.success).toBe(false);
    expect(result.channel).toBe("whatsapp");
    expect(result.error).toBeTruthy();
  });

  it("does not retry a non-retryable 4xx", async () => {
    // Only one request is intercepted; a retry would hit nock's default
    // unmatched request and fail loudly.
    nock(WHATSAPP_BASE_URL)
      .get(WHATSAPP_PATH)
      .query(true)
      .reply(400, "Bad Request");

    const result = await sendWhatsApp("Hello", CONFIG, {
      retryDelays: [5, 5],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("400");
  });

  it("exports the default retry delays it uses to reach 3 total attempts", () => {
    expect(WHATSAPP_DEFAULT_RETRY_DELAYS).toHaveLength(2);
  });
});
