import { describe, it, expect } from "vitest"
import { redactSensitiveFields, redactHeaders } from "../redaction"

describe("Redaction", () => {
	describe("redactSensitiveFields", () => {
		it("should redact apiKey fields", () => {
			const input = {
				apiKey: "sk-123456",
				model: "gpt-4",
				temperature: 0.7,
			}

			const result = redactSensitiveFields(input)

			expect(result).toEqual({
				apiKey: "[REDACTED]",
				model: "gpt-4",
				temperature: 0.7,
			})
		})

		it("should redact api_key fields", () => {
			const input = {
				api_key: "secret-key",
				other: "value",
			}

			const result = redactSensitiveFields(input)

			expect(result).toEqual({
				api_key: "[REDACTED]",
				other: "value",
			})
		})

		it("should redact token fields", () => {
			const input = {
				accessToken: "token-123",
				refreshToken: "token-456",
			}

			const result = redactSensitiveFields(input)

			expect(result).toEqual({
				accessToken: "[REDACTED]",
				refreshToken: "[REDACTED]",
			})
		})

		it("should redact nested sensitive fields", () => {
			const input = {
				config: {
					apiKey: "sk-123",
					model: "gpt-4",
					headers: {
						authorization: "Bearer token",
					},
				},
			}

			const result = redactSensitiveFields(input)

			expect(result).toEqual({
				config: {
					apiKey: "[REDACTED]",
					model: "gpt-4",
					headers: {
						authorization: "[REDACTED]",
					},
				},
			})
		})

		it("should handle arrays", () => {
			const input = [
				{ apiKey: "key1", value: "a" },
				{ apiKey: "key2", value: "b" },
			]

			const result = redactSensitiveFields(input)

			expect(result).toEqual([
				{ apiKey: "[REDACTED]", value: "a" },
				{ apiKey: "[REDACTED]", value: "b" },
			])
		})

		it("should preserve non-sensitive fields", () => {
			const input = {
				model: "gpt-4",
				temperature: 0.7,
				messages: [{ role: "user", content: "Hello" }],
			}

			const result = redactSensitiveFields(input)

			expect(result).toEqual(input)
		})

		it("should handle null and undefined", () => {
			expect(redactSensitiveFields(null)).toBe(null)
			expect(redactSensitiveFields(undefined)).toBe(undefined)
		})

		it("should handle primitives", () => {
			expect(redactSensitiveFields("string")).toBe("string")
			expect(redactSensitiveFields(123)).toBe(123)
			expect(redactSensitiveFields(true)).toBe(true)
		})
	})

	describe("redactHeaders", () => {
		it("should redact Authorization header", () => {
			const headers = {
				Authorization: "Bearer sk-123456",
				"Content-Type": "application/json",
			}

			const result = redactHeaders(headers)

			expect(result).toEqual({
				Authorization: "[REDACTED]",
				"Content-Type": "application/json",
			})
		})

		it("should redact authorization header (lowercase)", () => {
			const headers = {
				authorization: "Bearer sk-123456",
				"User-Agent": "RooCode/1.0",
			}

			const result = redactHeaders(headers)

			expect(result).toEqual({
				authorization: "[REDACTED]",
				"User-Agent": "RooCode/1.0",
			})
		})

		it("should handle undefined headers", () => {
			expect(redactHeaders(undefined)).toBe(undefined)
		})

		it("should preserve non-authorization headers", () => {
			const headers = {
				"Content-Type": "application/json",
				"User-Agent": "RooCode/1.0",
			}

			const result = redactHeaders(headers)

			expect(result).toEqual(headers)
		})
	})
})
