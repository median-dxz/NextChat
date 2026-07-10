import { NextRequest } from "next/server";
import { GET as providerRoute } from "../app/api/[provider]/[...path]/route";
import { OPTIONS as upstashRoute } from "../app/api/upstash/[action]/[...key]/route";
import { OPTIONS as webdavRoute } from "../app/api/webdav/[...path]/route";
import { GET as tencentRoute } from "../app/api/tencent/route";

function optionsRequest(path: string) {
  return new NextRequest(`https://nextchat.test${path}`, {
    method: "OPTIONS",
  });
}

describe("Next.js 16 route contexts", () => {
  test("resolves provider and catch-all params before dispatch", async () => {
    const response = await providerRoute(
      optionsRequest("/api/custom/v1/models"),
      {
        params: Promise.resolve({ provider: "custom", path: ["v1", "models"] }),
      },
    );

    expect(response.status).toBe(200);
  });

  test("resolves Upstash action and key params", async () => {
    const response = await upstashRoute(optionsRequest("/api/upstash/get/a"), {
      params: Promise.resolve({ action: "get", key: ["a"] }),
    });

    expect(response.status).toBe(200);
  });

  test("resolves WebDAV catch-all params", async () => {
    const response = await webdavRoute(optionsRequest("/api/webdav/a"), {
      params: Promise.resolve({ path: ["a"] }),
    });

    expect(response.status).toBe(200);
  });

  test("Tencent route no longer requires a phantom params context", async () => {
    const response = await tencentRoute(optionsRequest("/api/tencent"));

    expect(response.status).toBe(200);
  });
});
