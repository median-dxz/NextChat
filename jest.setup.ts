// Learn more: https://github.com/testing-library/jest-dom
import "@testing-library/jest-dom";
import { jest } from "@jest/globals";
import {
  Headers as FetchHeaders,
  Request as FetchRequest,
  Response as FetchResponse,
} from "node-fetch";
import { TextDecoder, TextEncoder } from "node:util";

Object.assign(global, {
  Headers: FetchHeaders,
  Request: FetchRequest,
  Response: FetchResponse,
  TextDecoder,
  TextEncoder,
});

global.fetch = jest.fn(
  async () =>
    new FetchResponse(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
) as unknown as jest.MockedFunction<typeof fetch>;
