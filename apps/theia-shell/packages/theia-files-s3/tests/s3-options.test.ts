import { describe, expect, it } from "vitest";
import { normalizeEndpoint, s3ClientOptions } from "../src/common/s3-options";

describe("S3 options", () => {
  it("normalizes the endpoint", () => {
    expect(normalizeEndpoint("http://127.0.0.1:9000/")).toBe("http://127.0.0.1:9000");
    expect(normalizeEndpoint(" https://s3.example.com ")).toBe("https://s3.example.com");
  });

  it("refuses an endpoint that is not an http(s) URL", () => {
    expect(() => normalizeEndpoint("localhost:9000")).toThrow(/http/);
    expect(() => normalizeEndpoint("ftp://x")).toThrow(/http/);
  });

  it("builds a path-style client config with the vault's credentials", () => {
    const options = s3ClientOptions(
      { endpoint: "http://h:9000/", region: "eu-west-3" },
      { accessKeyId: "AK", secretAccessKey: "SK" },
    );
    expect(options).toEqual({
      endpoint: "http://h:9000",
      region: "eu-west-3",
      forcePathStyle: true,
      credentials: { accessKeyId: "AK", secretAccessKey: "SK" },
    });
    expect(
      s3ClientOptions({ endpoint: "http://h" }, { accessKeyId: "a", secretAccessKey: "b" }).region,
    ).toBe("us-east-1");
  });
});
